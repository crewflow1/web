"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";

/**
 * Interim-valuation / application-for-payment server actions (migration
 * 20261192000000).
 *
 * RLS posture:
 *   - job_valuations           → members INSERT/UPDATE own-org; admins DELETE.
 *     A certified valuation's money columns are frozen by tg_job_valuations_freeze.
 *   - job_valuation_variations → members INSERT/DELETE own-org; the DB guard
 *     enforces validity (accepted variation, same job, no issued invoice, draft
 *     parent) and PINS the snapshot amount.
 *   - certify_valuation / generate_valuation_invoice → SECURITY DEFINER RPCs,
 *     admin-checked inside; they do the snapshot math and invoice generation.
 *
 * Every by-id UPDATE/DELETE carries `.eq("org_id", ctx.org.id)` — RLS bounds the
 * outer org SET, not the ACTIVE org, so the active-org pin is load-bearing.
 * Actions return FormState and navigate via `redirectTo` (full document load) —
 * a Server-Action redirect() back onto the same /jobs/[id] route is the swap
 * shape that loses navigations to the Next 15.5 stranded-commit race.
 *
 * job_valuations / job_valuation_variations post-date the generated Supabase
 * types (lib/supabase/types.ts), so the client is reached through a precise
 * structural shim — the same seam retention-actions.ts uses.
 */

const idSchema = z.string().uuid();
const valuationsUrl = (jobId: string, params: string): string =>
  `/jobs/${jobId}/valuations?${params}`;

type Res = { data: Record<string, unknown> | null; error: { message: string } | null };
type ListRes = { data: Record<string, unknown>[] | null; error: { message: string } | null };
type QB = {
  select: (c?: string) => QB;
  insert: (v: unknown) => QB;
  update: (v: unknown) => QB;
  delete: () => QB;
  eq: (k: string, v: unknown) => QB;
  in: (k: string, v: unknown[]) => QB;
  order: (k: string, o: { ascending: boolean }) => QB;
  limit: (n: number) => QB;
  maybeSingle: () => Promise<Res>;
  single: () => Promise<Res>;
} & PromiseLike<ListRes>;
type LooseDb = {
  from: (t: string) => QB;
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;
};

async function db(): Promise<LooseDb> {
  const supabase = await createClient();
  return supabase as unknown as LooseDb;
}

const optionalDate = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
);
const money = (label: string) =>
  z.coerce.number().min(0, `${label} can't be negative`).max(100_000_000, `${label} is unrealistically large`);

const detailsSchema = z.object({
  period_start: optionalDate,
  period_end: optionalDate,
  valuation_date: optionalDate,
  work_completed_to_date: money("Work completed"),
  materials_on_site: money("Materials on site"),
  deductions: money("Deductions"),
  vat_rate: z.coerce.number().min(0, "VAT rate can't be negative").max(100, "VAT rate can't exceed 100%"),
  notes: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(5000).optional(),
  ),
});

function parseDetails(formData: FormData) {
  return detailsSchema.safeParse({
    period_start: formData.get("period_start") ?? "",
    period_end: formData.get("period_end") ?? "",
    valuation_date: formData.get("valuation_date") ?? "",
    work_completed_to_date: formData.get("work_completed_to_date") ?? 0,
    materials_on_site: formData.get("materials_on_site") ?? 0,
    deductions: formData.get("deductions") ?? 0,
    vat_rate: formData.get("vat_rate") ?? 20,
    notes: formData.get("notes") ?? "",
  });
}

// ── create ───────────────────────────────────────────────────────────────────
export async function createValuation(
  jobId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { user, ctx } = await requireOrgContext();
  if (!idSchema.safeParse(jobId).success) return formError("That job link looks wrong — reload and try again.");

  const parsed = parseDetails(formData);
  if (!parsed.success) return formError(parsed.error.issues[0]?.message ?? "Invalid valuation");
  const input = parsed.data;

  const client = await db();

  // The job must live in the ACTIVE org (pin) — otherwise refuse.
  const jobRes = await client.from("jobs").select("id").eq("id", jobId).eq("org_id", ctx.org.id).maybeSingle();
  if (jobRes.error || !jobRes.data) return formError("That job isn't in your workspace.");

  // Next per-job application number.
  const seqRes = await client
    .from("job_valuations")
    .select("sequence")
    .eq("org_id", ctx.org.id)
    .eq("job_id", jobId)
    .order("sequence", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (seqRes.error) return formError("Couldn't read existing valuations — try again.");
  const nextSequence = Number(seqRes.data?.sequence ?? 0) + 1;

  const ins = await client
    .from("job_valuations")
    .insert({
      org_id: ctx.org.id,
      job_id: jobId,
      sequence: nextSequence,
      period_start: input.period_start ?? null,
      period_end: input.period_end ?? null,
      valuation_date: input.valuation_date ?? undefined,
      work_completed_to_date: input.work_completed_to_date,
      materials_on_site: input.materials_on_site,
      deductions: input.deductions,
      vat_rate: input.vat_rate,
      notes: input.notes ?? null,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (ins.error || !ins.data) return formError(ins.error?.message ?? "Couldn't create the valuation.");

  await recordActivity(ctx.org.id, "valuation.created", String(ins.data.id), {
    job_id: jobId,
    sequence: nextSequence,
  });
  return formSuccess({ redirectTo: valuationsUrl(jobId, "saved=valuation_created") });
}

// ── update (draft only) ───────────────────────────────────────────────────────
export async function updateValuation(
  valuationId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(valuationId).success) return formError("That valuation link looks wrong — reload.");

  const parsed = parseDetails(formData);
  if (!parsed.success) return formError(parsed.error.issues[0]?.message ?? "Invalid valuation");
  const input = parsed.data;

  const client = await db();
  const upd = await client
    .from("job_valuations")
    .update({
      period_start: input.period_start ?? null,
      period_end: input.period_end ?? null,
      valuation_date: input.valuation_date ?? undefined,
      work_completed_to_date: input.work_completed_to_date,
      materials_on_site: input.materials_on_site,
      deductions: input.deductions,
      vat_rate: input.vat_rate,
      notes: input.notes ?? null,
    })
    .eq("id", valuationId)
    .eq("org_id", ctx.org.id)
    .eq("status", "draft")
    .select("id, job_id")
    .maybeSingle();
  if (upd.error) return formError(upd.error.message);
  if (!upd.data) return formError("Only a draft valuation can be edited.");

  await recordActivity(ctx.org.id, "valuation.updated", valuationId, {});
  return formSuccess({ redirectTo: valuationsUrl(String(upd.data.job_id), "saved=valuation_updated") });
}

// ── submit (draft → submitted) ────────────────────────────────────────────────
export async function submitValuation(valuationId: string, _prev: FormState): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(valuationId).success) return formError("That valuation link looks wrong — reload.");

  const client = await db();
  const upd = await client
    .from("job_valuations")
    .update({ status: "submitted" })
    .eq("id", valuationId)
    .eq("org_id", ctx.org.id)
    .eq("status", "draft")
    .select("id, job_id")
    .maybeSingle();
  if (upd.error) return formError(upd.error.message);
  if (!upd.data) return formError("Only a draft valuation can be submitted.");

  await recordActivity(ctx.org.id, "valuation.submitted", valuationId, {});
  return formSuccess({ redirectTo: valuationsUrl(String(upd.data.job_id), "saved=valuation_submitted") });
}

// ── cancel (draft/submitted → cancelled) ──────────────────────────────────────
export async function cancelValuation(valuationId: string, _prev: FormState): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(valuationId).success) return formError("That valuation link looks wrong — reload.");

  const client = await db();
  const upd = await client
    .from("job_valuations")
    .update({ status: "cancelled" })
    .eq("id", valuationId)
    .eq("org_id", ctx.org.id)
    .in("status", ["draft", "submitted"])
    .select("id, job_id")
    .maybeSingle();
  if (upd.error) return formError(upd.error.message);
  if (!upd.data) return formError("Only a draft or submitted valuation can be cancelled.");

  await recordActivity(ctx.org.id, "valuation.cancelled", valuationId, {});
  return formSuccess({ redirectTo: valuationsUrl(String(upd.data.job_id), "saved=valuation_cancelled") });
}

// ── certify (submitted → certified) — admin RPC ───────────────────────────────
export async function certifyValuation(
  valuationId: string,
  jobId: string,
  _prev: FormState,
): Promise<FormState> {
  await requireOrgContext();
  if (!idSchema.safeParse(valuationId).success || !idSchema.safeParse(jobId).success) {
    return formError("That valuation link looks wrong — reload.");
  }
  const client = await db();
  const { error } = await client.rpc("certify_valuation", { p_valuation_id: valuationId });
  if (error) return formError(error.message);
  return formSuccess({ redirectTo: valuationsUrl(jobId, "saved=valuation_certified") });
}

// ── generate invoice (certified → invoiced) — admin RPC ───────────────────────
export async function generateValuationInvoice(
  valuationId: string,
  jobId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireOrgContext();
  if (!idSchema.safeParse(valuationId).success || !idSchema.safeParse(jobId).success) {
    return formError("That valuation link looks wrong — reload.");
  }
  const dueRaw = formData.get("due_date");
  const due = typeof dueRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dueRaw) ? dueRaw : null;

  const client = await db();
  const { data, error } = await client.rpc("generate_valuation_invoice", {
    p_valuation_id: valuationId,
    p_due_date: due,
  });
  if (error) return formError(error.message);
  const invoiceId = typeof data === "string" ? data : null;
  return formSuccess({
    redirectTo: invoiceId ? `/invoices/${invoiceId}?saved=valuation_invoiced` : valuationsUrl(jobId, "saved=valuation_invoiced"),
  });
}

// ── link a variation (draft only; guard enforces validity) ────────────────────
export async function linkVariation(
  valuationId: string,
  jobId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const { user, ctx } = await requireOrgContext();
  if (!idSchema.safeParse(valuationId).success || !idSchema.safeParse(jobId).success) {
    return formError("That valuation link looks wrong — reload.");
  }
  const variationId = String(formData.get("variation_quote_id") ?? "");
  if (!idSchema.safeParse(variationId).success) return formError("Pick a variation to include.");

  const client = await db();
  // amount is PINNED by the DB guard from the variation's subtotal — send 0.
  const ins = await client
    .from("job_valuation_variations")
    .insert({
      org_id: ctx.org.id,
      valuation_id: valuationId,
      variation_quote_id: variationId,
      amount: 0,
      created_by: user.id,
    })
    .select("id")
    .maybeSingle();
  if (ins.error) return formError(ins.error.message);

  await recordActivity(ctx.org.id, "valuation.variation_linked", valuationId, {
    variation_quote_id: variationId,
  });
  return formSuccess({ redirectTo: valuationsUrl(jobId, "saved=variation_linked") });
}

// ── unlink a variation ────────────────────────────────────────────────────────
export async function unlinkVariation(
  linkId: string,
  jobId: string,
  _prev: FormState,
): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(linkId).success || !idSchema.safeParse(jobId).success) {
    return formError("That link looks wrong — reload.");
  }
  const client = await db();
  const del = await client
    .from("job_valuation_variations")
    .delete()
    .eq("id", linkId)
    .eq("org_id", ctx.org.id)
    .select("id")
    .maybeSingle();
  if (del.error) return formError(del.error.message);

  await recordActivity(ctx.org.id, "valuation.variation_unlinked", jobId, { link_id: linkId });
  return formSuccess({ redirectTo: valuationsUrl(jobId, "saved=variation_unlinked") });
}

/**
 * Audit via the SECURITY DEFINER _record_activity RPC (the activity_log write
 * authority) on the admin client — best-effort, never blocks the action.
 */
async function recordActivity(
  orgId: string,
  action: string,
  targetId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient() as unknown as LooseDb;
    await admin.rpc("_record_activity", {
      p_org_id: orgId,
      p_action: action,
      p_target_table: "job_valuations",
      p_target_id: targetId,
      p_metadata: metadata,
    });
  } catch {
    /* audit is best-effort — the mutation already succeeded */
  }
}
