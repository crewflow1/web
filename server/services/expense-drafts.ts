import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { isAiConfigured } from "@/lib/ai/safety";
import { expenseDraftApproveSchema } from "@/lib/suppliers/schema";
import { z } from "zod";

/**
 * Phase D — Expense draft workflow.
 *
 *   1. Operator uploads a receipt / invoice via /suppliers/expenses/new.
 *      The file lands in storage; an `expense_drafts` row holds the
 *      AI-extracted candidate values (amount / VAT / supplier / etc).
 *
 *   2. Operator reviews the draft. Nothing is posted to `finances`
 *      yet — the directive's "Nothing auto-posted" rule.
 *
 *   3. Operator approves → we INSERT a `finances` row with the
 *      reviewed values, stamp `expense_drafts.finance_id`, and
 *      audit-log. The draft transitions to `approved`.
 *
 *   4. Operator rejects → draft moves to `rejected` with a reason.
 *
 * AI extraction is best-effort — when no AI key is configured, the
 * draft is created with NULL extraction fields and the operator
 * types the values manually.
 */

export type DraftExtraction = {
  amount: number | null;
  vat_rate: number | null;
  vat_total: number | null;
  total: number | null;
  supplier_name: string | null;
  category: string | null;
  invoice_date: string | null;
  reference: string | null;
  confidence: number;
};

/** Create a draft row from an uploaded receipt. The caller is
 *  responsible for the storage upload (we just record the metadata). */
export async function createExpenseDraftFromUpload(input: {
  uploadId: string;
  filename: string;
  mimeType: string;
  rawBytes: Uint8Array | null;
}): Promise<{ id: string } | null> {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  // AI extraction. When no key, fields stay null; operator fills.
  const extraction = await maybeExtractReceipt(input.rawBytes, input.mimeType);

  const { data, error } = await (
    supabase.from("expense_drafts" as never) as unknown as {
      insert: (row: unknown) => {
        select: (cols: string) => {
          single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }>;
        };
      };
    }
  )
    .insert({
      org_id: ctx.org.id,
      upload_id: input.uploadId,
      amount: extraction.amount,
      vat_rate: extraction.vat_rate,
      vat_total: extraction.vat_total,
      total: extraction.total,
      supplier_name: extraction.supplier_name,
      category: extraction.category,
      invoice_date: extraction.invoice_date,
      reference: extraction.reference,
      ai_confidence: extraction.confidence,
      status: "extracted",
    })
    .select("id")
    .single();
  if (error) {
    console.error("[expense-drafts] create failed", error);
    return null;
  }
  return data as { id: string };
}

/** Owner/admin approves a draft. Creates a `finances` row + stamps
 *  the draft. The stamp uses the service-role admin client (RLS
 *  bypassed), so the owner/admin gate and org-scoping are enforced in
 *  code below — see the SECURITY notes. */
export async function approveExpenseDraft(input: z.infer<typeof expenseDraftApproveSchema>): Promise<{
  ok: true;
  finance_id: string;
} | { ok: false; error: string }> {
  const { ctx, user } = await requireOrgContext();
  const parsed = expenseDraftApproveSchema.parse(input);
  const supabase = await createClient();
  const admin = createAdminClient();

  // SECURITY: owner/admin only. The `expense_drafts` UPDATE RLS policy is
  // `is_org_admin(org_id)`, but step 2 stamps the draft with the service-role
  // admin client, which BYPASSES RLS — so the role gate has to be enforced
  // here in code. Without it any member could approve a draft and post to
  // `finances`, defeating the admin-only approval intent. Same idiom as the
  // settings/payments/quotes server actions.
  if (ctx.membership.role !== "owner" && ctx.membership.role !== "admin") {
    return { ok: false, error: "forbidden" };
  }

  // SECURITY: confirm the draft belongs to the caller's org BEFORE writing
  // anything. Read on the tenant client (RLS-scoped) with an explicit org
  // filter — a member of org B passing org A's draft_id finds no row and we
  // bail. Without this, the org-scoped UPDATE in step 2 would correctly no-op,
  // but the finances INSERT in step 1 would already have written a bogus row.
  const { data: draft } = await (
    supabase.from("expense_drafts" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{
              data: { id: string; status: string | null; finance_id: string | null } | null;
            }>;
          };
        };
      };
    }
  )
    .select("id, status, finance_id")
    .eq("id", parsed.draft_id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (!draft) {
    return { ok: false, error: "draft_not_found" };
  }

  // IDEMPOTENCY: bail BEFORE the finances INSERT if this draft was already
  // approved — a double-submit of the approval form (or re-approving a stamped
  // draft) would otherwise post a SECOND `finances` row and re-stamp the draft,
  // duplicating the expense on the books. Same class of bug as the quote-accept
  // double-invoicing guard in acceptQuoteByToken. Return the already-stamped
  // finance_id as an idempotent success; only the degenerate approved-without-
  // finance_id state falls through to the error contract.
  if (draft.status === "approved" || draft.finance_id) {
    return draft.finance_id
      ? { ok: true, finance_id: draft.finance_id }
      : { ok: false, error: "already_approved" };
  }

  // 1. INSERT into finances (RLS scoped to org via the tenant client).
  const { data: finance, error: finErr } = await supabase
    .from("finances")
    .insert({
      org_id: ctx.org.id,
      amount: parsed.amount,
      vat_rate: parsed.vat_rate,
      category: parsed.category ?? null,
      supplier_id: parsed.supplier_id ?? null,
    } as never)
    .select("id")
    .single();
  if (finErr || !finance) {
    console.error("[expense-drafts] finance insert failed", finErr);
    return { ok: false, error: finErr?.message ?? "finance_insert_failed" };
  }
  const financeId = (finance as { id: string }).id;

  // 2. Stamp the draft.
  //
  // SECURITY: this uses the service-role admin client (RLS bypassed), so the
  // update MUST be scoped to the caller's org explicitly. Without the
  // `.eq("org_id", ...)` guard, any authenticated member could pass another
  // org's draft_id and flip that tenant's draft to `approved` (the
  // expense_drafts UPDATE RLS policy `is_org_admin(org_id)` never runs on the
  // admin client). Mirrors the org-scoping rejectExpenseDraft already applies.
  await (admin.from("expense_drafts" as never) as unknown as {
    update: (row: unknown) => {
      eq: (k: string, v: unknown) => {
        eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
      };
    };
  })
    .update({
      status: "approved",
      finance_id: financeId,
      approved_at: new Date().toISOString(),
      approved_by: user.id,
      supplier_id: parsed.supplier_id ?? null,
      amount: parsed.amount,
      vat_rate: parsed.vat_rate,
      category: parsed.category ?? null,
    })
    .eq("id", parsed.draft_id)
    .eq("org_id", ctx.org.id);

  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action: "expense_draft.approved",
    targetTable: "expense_drafts",
    targetId: parsed.draft_id,
    metadata: { finance_id: financeId, amount: parsed.amount },
  });

  return { ok: true, finance_id: financeId };
}

// ---------------------------------------------------------------------
// AI extraction — Claude vision on a receipt image/PDF.
// Reuses the existing imports/ocr.ts pattern.
// ---------------------------------------------------------------------

async function maybeExtractReceipt(
  bytes: Uint8Array | null,
  mimeType: string,
): Promise<DraftExtraction> {
  if (!isAiConfigured() || !bytes || bytes.length === 0) {
    return {
      amount: null,
      vat_rate: null,
      vat_total: null,
      total: null,
      supplier_name: null,
      category: null,
      invoice_date: null,
      reference: null,
      confidence: 0,
    };
  }
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
    const base64 = Buffer.from(bytes).toString("base64");
    const isImage = mimeType.startsWith("image/");
    const isPdf = mimeType === "application/pdf";
    if (!isImage && !isPdf) {
      return zeroExtraction();
    }
    const docBlock: Record<string, unknown> = isPdf
      ? {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: base64 },
        }
      : {
          type: "image",
          source: { type: "base64", media_type: mimeType, data: base64 },
        };
    const msg = await client.messages.create(
      {
        model: "claude-haiku-4-5",
        max_tokens: 600,
        system: [
          "You read a UK supplier receipt or invoice and return ONE JSON object:",
          '{ "amount": number|null, "vat_rate": 0|5|20|null, "vat_total": number|null, "total": number|null, "supplier_name": string|null, "category": string|null, "invoice_date": "YYYY-MM-DD"|null, "reference": string|null, "confidence": 0-100 }',
          "amount is the NET (ex-VAT) figure. total is gross (inc VAT).",
          "If unclear, return null + lower confidence. NEVER hallucinate.",
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: [
              docBlock as never,
              { type: "text", text: "Extract the values per the schema." },
            ],
          },
        ],
      },
      { signal: AbortSignal.timeout(15_000) },
    );
    const block = msg.content[0];
    if (block?.type === "text") {
      const raw = extractJson(block.text);
      if (raw && typeof raw === "object") {
        return normaliseExtraction(raw as Record<string, unknown>);
      }
    }
  } catch (e) {
    console.error("[expense-drafts] OCR failed", e);
  }
  return zeroExtraction();
}

function zeroExtraction(): DraftExtraction {
  return {
    amount: null,
    vat_rate: null,
    vat_total: null,
    total: null,
    supplier_name: null,
    category: null,
    invoice_date: null,
    reference: null,
    confidence: 0,
  };
}

function normaliseExtraction(raw: Record<string, unknown>): DraftExtraction {
  const vatRateRaw = typeof raw.vat_rate === "number" ? raw.vat_rate : null;
  const vat_rate = vatRateRaw === 0 || vatRateRaw === 5 || vatRateRaw === 20 ? vatRateRaw : null;
  const num = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return Math.round(v * 100) / 100;
    return null;
  };
  const confidenceRaw = typeof raw.confidence === "number" ? raw.confidence : 0;
  const confidence = Math.max(0, Math.min(100, Math.round(confidenceRaw)));
  // Conservative cap — OCR always needs review (same as imports/ocr.ts).
  return {
    amount: num(raw.amount),
    vat_rate,
    vat_total: num(raw.vat_total),
    total: num(raw.total),
    supplier_name: typeof raw.supplier_name === "string" ? raw.supplier_name : null,
    category: typeof raw.category === "string" ? raw.category : null,
    invoice_date:
      typeof raw.invoice_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.invoice_date)
        ? raw.invoice_date
        : null,
    reference: typeof raw.reference === "string" ? raw.reference : null,
    confidence: Math.min(85, confidence),
  };
}

function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
}
