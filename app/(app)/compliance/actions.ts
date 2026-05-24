"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";

/**
 * Phase E — Compliance document actions.
 *
 *   uploadComplianceDocument → file to `compliance-docs` bucket +
 *     compliance_documents row with kind/title/expiry.
 *
 *   deleteComplianceDocument → removes the storage object + row.
 *
 * Only owner/admins can manage compliance docs (RLS gates writes via
 * is_org_admin()).
 */

const KIND = z.enum(["insurance", "certificate", "permit", "contract", "other"]);

const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/webp",
]);
const MAX_BYTES = 25 * 1024 * 1024;

const uploadSchema = z.object({
  kind: KIND,
  title: z.string().trim().min(1, "Title is required").max(200),
  expires_at: z
    .string()
    .trim()
    .optional()
    .refine(
      (v) => !v || /^\d{4}-\d{2}-\d{2}$/.test(v),
      "Use the date picker — format must be YYYY-MM-DD",
    )
    .or(z.literal("").transform(() => undefined)),
  notes: z
    .string()
    .trim()
    .max(2000)
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

const idSchema = z.string().uuid();

export async function uploadComplianceDocument(formData: FormData): Promise<void> {
  const { ctx, user } = await requireOrgContext();

  const parsed = uploadSchema.safeParse({
    kind: formData.get("kind") ?? "",
    title: formData.get("title") ?? "",
    expires_at: formData.get("expires_at") ?? "",
    notes: formData.get("notes") ?? "",
  });
  if (!parsed.success) {
    const issues = parsed.error.flatten().fieldErrors;
    const firstError = Object.values(issues).flat()[0] ?? "validation";
    redirect(`/compliance/new?error=${encodeURIComponent(firstError)}`);
  }

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    redirect("/compliance/new?error=no_file");
  }
  if (!ALLOWED_MIME.has(file.type)) {
    redirect("/compliance/new?error=bad_type");
  }
  if (file.size > MAX_BYTES) {
    redirect("/compliance/new?error=too_large");
  }

  const admin = createAdminClient();
  const docId = randomUUID();
  const ext = mimeToExt(file.type);
  const storagePath = `${ctx.org.id}/${docId}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: uploadErr } = await admin.storage
    .from("compliance-docs")
    .upload(storagePath, bytes, {
      contentType: file.type,
      upsert: false,
    });
  if (uploadErr) {
    console.error("[compliance] upload failed", uploadErr);
    redirect("/compliance/new?error=upload_failed");
  }

  const tenant = await createClient();
  const data = parsed.success ? parsed.data : null;
  const { error: insErr } = await (
    tenant.from("compliance_documents" as never) as unknown as {
      insert: (row: unknown) => Promise<{ error: { message: string } | null }>;
    }
  ).insert({
    id: docId,
    org_id: ctx.org.id,
    kind: data?.kind,
    title: data?.title,
    storage_path: storagePath,
    filename: file.name,
    mime_type: file.type,
    size_bytes: file.size,
    expires_at: data?.expires_at ?? null,
    notes: data?.notes ?? null,
    uploaded_by: user.id,
  });
  if (insErr) {
    console.error("[compliance] insert failed", insErr);
    await admin.storage.from("compliance-docs").remove([storagePath]).catch(() => undefined);
    redirect("/compliance/new?error=record_failed");
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "compliance_document.uploaded",
    targetTable: "compliance_documents",
    targetId: docId,
    metadata: { kind: data?.kind, title: data?.title, expires_at: data?.expires_at ?? null },
  });

  revalidatePath("/compliance");
  redirect(`/compliance?saved=uploaded`);
}

export async function deleteComplianceDocument(id: string): Promise<void> {
  const { ctx, user } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/compliance?error=bad_id");

  const tenant = await createClient();
  const admin = createAdminClient();

  // Fetch row first so we know what to delete from storage.
  const { data: row } = await (
    tenant.from("compliance_documents" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          maybeSingle: () => Promise<{
            data: { storage_path: string | null; title: string | null } | null;
          }>;
        };
      };
    }
  )
    .select("storage_path, title")
    .eq("id", id)
    .maybeSingle();

  const { error } = await (
    tenant.from("compliance_documents" as never) as unknown as {
      delete: () => {
        eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
      };
    }
  )
    .delete()
    .eq("id", id);

  if (error) {
    console.error("[compliance] delete failed", error);
    redirect(`/compliance?error=delete_failed`);
  }

  if (row?.storage_path) {
    await admin.storage
      .from("compliance-docs")
      .remove([row.storage_path])
      .catch(() => undefined);
  }

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "compliance_document.deleted",
    targetTable: "compliance_documents",
    targetId: id,
    metadata: { title: row?.title ?? null, org_id: ctx.org.id },
  });

  revalidatePath("/compliance");
  redirect(`/compliance?saved=deleted`);
}

export async function getComplianceDocSignedUrl(id: string): Promise<string | null> {
  await requireOrgContext();
  if (!idSchema.safeParse(id).success) return null;

  const tenant = await createClient();
  const admin = createAdminClient();

  const { data: row } = await (
    tenant.from("compliance_documents" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          maybeSingle: () => Promise<{ data: { storage_path: string | null } | null }>;
        };
      };
    }
  )
    .select("storage_path")
    .eq("id", id)
    .maybeSingle();

  if (!row?.storage_path) return null;

  const { data: signed } = await admin.storage
    .from("compliance-docs")
    .createSignedUrl(row.storage_path, 60);
  return signed?.signedUrl ?? null;
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
