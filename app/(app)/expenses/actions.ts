"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";

/**
 * Phase D — Expense draft actions.
 *
 *   uploadExpenseReceipt → uploads receipt to `receipts` bucket,
 *     creates the expense_drafts row, kicks off Claude vision OCR
 *     via createExpenseDraftFromUpload() in a best-effort way.
 *
 *   approveExpenseDraftAction → user has reviewed the extracted
 *     values; persist to finances via the approveExpenseDraft service.
 *
 *   rejectExpenseDraft → mark the draft rejected with a reason.
 */

const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
]);
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB — matches `receipts` bucket cap

const VAT_RATE = z.coerce.number().refine((v) => v === 0 || v === 5 || v === 20, {
  message: "VAT rate must be 0, 5 or 20",
});

const approveSchema = z.object({
  draft_id: z.string().uuid(),
  amount: z.coerce.number().min(0).max(10_000_000),
  vat_rate: VAT_RATE,
  category: z
    .string()
    .trim()
    .max(80)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  supplier_id: z
    .string()
    .uuid()
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

const rejectSchema = z.object({
  draft_id: z.string().uuid(),
  reason: z.string().trim().max(500).optional(),
});

const idSchema = z.string().uuid();

export async function uploadExpenseReceipt(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    redirect("/expenses/new?error=no_file");
  }
  if (!ALLOWED_MIME.has(file.type)) {
    redirect("/expenses/new?error=bad_type");
  }
  if (file.size > MAX_BYTES) {
    redirect("/expenses/new?error=too_large");
  }

  const admin = createAdminClient();
  const uploadId = randomUUID();
  const ext = mimeToExt(file.type);
  // Path under existing `receipts` bucket — uses `<org>/drafts/<id>.<ext>`
  // to keep it distinct from the per-finance-id receipts the books module
  // already manages.
  const storagePath = `${ctx.org.id}/drafts/${uploadId}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: uploadErr } = await admin.storage
    .from("receipts")
    .upload(storagePath, bytes, {
      contentType: file.type,
      upsert: false,
    });
  if (uploadErr) {
    console.error("[expenses] upload failed", uploadErr);
    redirect("/expenses/new?error=upload_failed");
  }

  // Create the draft row + run OCR. Done in-band so the user sees the
  // extracted values immediately on the approval screen. OCR confidence
  // is capped at 85 % inside the service — review is always required.
  const { createExpenseDraftFromUpload } = await import(
    "@/server/services/expense-drafts"
  );
  const created = await createExpenseDraftFromUpload({
    uploadId,
    filename: file.name,
    mimeType: file.type,
    rawBytes: bytes,
  });

  if (!created) {
    // Orphan cleanup.
    await admin.storage.from("receipts").remove([storagePath]).catch(() => undefined);
    redirect("/expenses/new?error=draft_failed");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "expense_draft.created",
    targetTable: "expense_drafts",
    targetId: created.id,
    metadata: {
      filename: file.name,
      mime_type: file.type,
      size_bytes: file.size,
    },
  });

  revalidatePath("/expenses");
  redirect(`/expenses/${created.id}`);
}

export async function approveExpenseDraftAction(formData: FormData): Promise<void> {
  await requireOrgContext();
  const parsed = approveSchema.safeParse({
    draft_id: formData.get("draft_id") ?? "",
    amount: formData.get("amount") ?? "",
    vat_rate: formData.get("vat_rate") ?? "",
    category: formData.get("category") ?? "",
    supplier_id: formData.get("supplier_id") ?? "",
  });
  if (!parsed.success) {
    const id = String(formData.get("draft_id") ?? "");
    redirect(`/expenses/${id}?error=validation`);
  }

  const { approveExpenseDraft } = await import("@/server/services/expense-drafts");
  const result = await approveExpenseDraft(parsed.data);
  if (!result.ok) {
    redirect(`/expenses/${parsed.data.draft_id}?error=approve_failed`);
  }

  revalidatePath("/expenses");
  revalidatePath("/finances");
  redirect(`/expenses?saved=approved`);
}

export async function rejectExpenseDraft(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  const parsed = rejectSchema.safeParse({
    draft_id: formData.get("draft_id") ?? "",
    reason: formData.get("reason") ?? "",
  });
  if (!parsed.success) {
    const id = String(formData.get("draft_id") ?? "");
    redirect(`/expenses/${id}?error=validation`);
  }

  // SECURITY (P2 audit M-3): reject runs on the service-role admin client,
  // which BYPASSES RLS — so the `expense_drafts` admin-only UPDATE policy
  // (`is_org_admin(org_id)`, migration 20260623000000) never executes here.
  // Re-enforce the owner/admin gate in code, exactly as approveExpenseDraft
  // does; otherwise any authenticated member could reject (and thereby kill)
  // a draft the org reserves for admin review.
  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    redirect(`/expenses/${parsed.data.draft_id}?error=forbidden`);
  }

  // Confirm the draft exists in the caller's org and is still pending review.
  // Read on the RLS-scoped tenant client with an explicit org filter: a
  // foreign/nonexistent draft_id finds no row (no silent false-success), and
  // an already-approved/finance-stamped draft is refused so we never flip a
  // posted expense to `rejected` and orphan its `finances` row. Mirrors the
  // idempotency guard in approveExpenseDraft.
  const supabase = await createClient();
  const { data: draft, error: draftError } = await (
    supabase.from("expense_drafts" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{
              data: {
                id: string;
                status: string | null;
                finance_id: string | null;
              } | null;
              error: SupabaseReadError | null;
            }>;
          };
        };
      };
    }
  )
    .select("id, status, finance_id")
    .eq("id", parsed.data.draft_id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  // A failed guard read must not masquerade as "draft not found" — throw so the
  // reject never proceeds on an unverified draft.
  if (draftError) throw readFailure("expense draft: reject guard", draftError);
  if (!draft) {
    redirect(`/expenses/${parsed.data.draft_id}?error=not_found`);
  }
  if (draft.status === "approved" || draft.finance_id) {
    redirect(`/expenses/${parsed.data.draft_id}?error=already_approved`);
  }

  const admin = createAdminClient();
  const { error } = await (
    admin.from("expense_drafts" as never) as unknown as {
      update: (row: unknown) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
        };
      };
    }
  )
    .update({
      status: "rejected",
      rejected_at: new Date().toISOString(),
      rejection_reason: parsed.data.reason ?? null,
    })
    .eq("id", parsed.data.draft_id)
    .eq("org_id", ctx.org.id);

  if (error) {
    console.error("[expenses] reject failed", error);
    redirect(`/expenses/${parsed.data.draft_id}?error=reject_failed`);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "expense_draft.rejected",
    targetTable: "expense_drafts",
    targetId: parsed.data.draft_id,
    metadata: { reason: parsed.data.reason ?? null },
  });

  revalidatePath("/expenses");
  redirect(`/expenses?saved=rejected`);
}

function mimeToExt(mime: string): string {
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/heic") return "heic";
  if (mime === "image/heif") return "heif";
  if (mime === "image/webp") return "webp";
  return "bin";
}

// Silence linter on unused exports — these are imported by the
// expenses pages.
void idSchema;
