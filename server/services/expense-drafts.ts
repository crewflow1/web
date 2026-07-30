import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { getVisionProvider } from "@/lib/ai/vision";
import { invokeWithGovernor, type GovernedCall } from "@/lib/ai/governor";
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
 * AI extraction is best-effort — when no vision provider is available
 * (no cost tier bound, or no vendor credential), the draft is created
 * with NULL extraction fields and the operator types the values
 * manually. That is the live path in production today.
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
  const { ctx, user } = await requireOrgContext();
  const supabase = await createClient();

  // AI extraction. No vision provider ⇒ fields stay null; operator fills.
  // Runs under the AI Cost Governor — see maybeExtractReceipt.
  const extraction = await maybeExtractReceipt(input.rawBytes, input.mimeType, {
    orgId: ctx.org.id,
    userId: user.id,
  });

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
  const { data: draft, error: draftError } = await (
    supabase.from("expense_drafts" as never) as unknown as {
      select: (cols: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{
              data: { id: string; status: string | null; finance_id: string | null } | null;
              error: SupabaseReadError | null;
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
  if (draftError) throw readFailure("expense-drafts: draft gate", draftError);
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
// AI extraction — vision on a receipt image/PDF, through the SHARED door.
//
// GOVERNED. The provider call is wrapped in `invokeWithGovernor`
// (lib/ai/governor.ts), which is the seam every AI call in CrewFlow passes
// through: it refuses when the org is at its £100 monthly ceiling, refuses a
// re-upload of a receipt it already read minutes ago, and records tokens /
// latency / estimated cost for the ones it lets through.
//
// ONE VISION DOOR. This used to construct `@anthropic-ai/sdk` itself and gate on
// `isAiConfigured()` — a bare credential check. So did lib/imports/ocr.ts, with
// its own copy of the same SDK construction, its own model string and its own
// PDF-vs-image block. Both now go through lib/ai/vision, which owns the
// transport and — the load-bearing part — requires the governor to be ACTIVATED
// (a bound cost tier), not merely a key to be present. A credential on a deploy
// can no longer switch paid vision extraction on outside the ceiling.
//
// DARK TODAY, AND UNCHANGED BY THE WRAPPING. No tier is bound to a model, so
// `getVisionProvider()` below returns null and this function returns the same
// empty extraction it always did, without the governor performing a single
// database read. The degraded path — the operator types the values — is the live
// behaviour and remains byte-for-byte identical.
//
// EVENT-DRIVEN. This is an upload handler: it runs when a receipt ARRIVES, once
// per receipt. It is never on a render path.
// ---------------------------------------------------------------------

async function maybeExtractReceipt(
  bytes: Uint8Array | null,
  mimeType: string,
  actor: { orgId: string; userId: string | null },
): Promise<DraftExtraction> {
  const vision = getVisionProvider();
  if (!vision || !bytes || bytes.length === 0) {
    return zeroExtraction();
  }
  const isImage = mimeType.startsWith("image/");
  const isPdf = mimeType === "application/pdf";
  if (!isImage && !isPdf) {
    return zeroExtraction();
  }
  const base64 = Buffer.from(bytes).toString("base64");

  try {
    const outcome = await invokeWithGovernor(
      "expense.receipt_extraction",
      "classification",
      () => readReceiptWithProvider(vision, base64, mimeType, isPdf),
      {
        orgId: actor.orgId,
        userId: actor.userId,
        // The receipt's own bytes are the dedupe identity: the same file
        // re-uploaded (a double-submit, a retried form) must not be read twice.
        // Only the SHA-256 of this reaches the ledger — never the bytes.
        dedupeContent: base64,
      },
    );
    // `blocked` (over ceiling) and `duplicate` degrade exactly as "no key" does:
    // an empty draft the operator completes. A cost control that broke the
    // upload instead of the enrichment would be a worse outcome than the spend.
    if (outcome.status === "ran") return outcome.value;
  } catch (e) {
    // Unchanged: the governor RECORDS the failure and rethrows, so this catch
    // still owns the degraded path exactly as it did before.
    console.error("[expense-drafts] OCR failed", e);
  }
  return zeroExtraction();
}

/**
 * The provider leg, isolated so the governor can time it and account for it.
 * Returns `usage` describing what was actually billed; the governor records
 * that. Throws on any provider failure — the caller owns the degraded path.
 */
async function readReceiptWithProvider(
  vision: NonNullable<ReturnType<typeof getVisionProvider>>,
  base64: string,
  mimeType: string,
  isPdf: boolean,
): Promise<GovernedCall<DraftExtraction>> {
  const result = await vision.extract(
    {
      kind: isPdf ? "pdf" : "image",
      mediaType: isPdf ? "application/pdf" : mimeType,
      base64,
    },
    {
      system: RECEIPT_SYSTEM_PROMPT,
      instruction: "Extract the values per the schema.",
      // A receipt is one page of fields; 600 tokens is ample and bounds the cost.
      maxTokens: 600,
      signal: AbortSignal.timeout(15_000),
    },
  );
  // The vendor's own billed counts — the ledger records provider truth, never
  // an estimate of the token count.
  const usage = {
    provider: vision.info.provider,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  };
  const raw = extractJson(result.text);
  if (raw && typeof raw === "object") {
    return { value: normaliseExtraction(raw as Record<string, unknown>), usage };
  }
  // A response we could not parse still COST what it cost — report the usage so
  // the ledger reflects the spend, and return the same empty draft as before.
  return { value: zeroExtraction(), usage };
}

/** The fixed framing. No receipt content can steer it. */
const RECEIPT_SYSTEM_PROMPT = [
  "You read a UK supplier receipt or invoice and return ONE JSON object:",
  '{ "amount": number|null, "vat_rate": 0|5|20|null, "vat_total": number|null, "total": number|null, "supplier_name": string|null, "category": string|null, "invoice_date": "YYYY-MM-DD"|null, "reference": string|null, "confidence": 0-100 }',
  "amount is the NET (ex-VAT) figure. total is gross (inc VAT).",
  "If unclear, return null + lower confidence. NEVER hallucinate.",
].join("\n");

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
