"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { requireCapabilityFor } from "@/server/auth/capabilities";
import { loadJobForOrg } from "@/lib/jobs/load";
import type { Database } from "@/lib/supabase/types";

/**
 * Quote VARIATION + Extension-of-Time (EoT) server actions.
 *
 * Extracted verbatim from quotes/actions.ts (pre-launch architecture pass) so the
 * variation/EoT sub-domain lives apart from core quote CRUD. A variation is a
 * child quote carrying the parent job_id + a variation_number; on accept it
 * invoices and rolls up under the same job. EoT agreements are recorded here too.
 * Logic is byte-identical to the original — only the file boundary changed.
 */

const idSchema = z.string().uuid();
type LineItemInsert = Database["public"]["Tables"]["quote_line_items"]["Insert"];

/**
 * Create a Variation Order — a quote scoped to a specific job with a
 * per-job sequence number. Uses the same quotes/quote_line_items
 * pipeline so PDF + public portal + accept/decline + auto-invoice all
 * work for free.
 *
 * The form captures the operator's cost breakdown (labour/materials/
 * subcontractors/misc) + desired margin %; revenue is derived. Each
 * non-zero cost bucket becomes a quote_line_item so the PDF reads
 * cleanly, while the customer-facing line shows the bucket as a
 * description and the bucket's net-of-margin price as the unit_price.
 *
 * For the customer the variation looks like a small quote with a few
 * line items. Internally we mark it as a variation via the new
 * quotes.variation_number column. On accept, an invoice is generated
 * exactly as for a normal quote — and because we carry the job_id
 * through, the new invoice automatically rolls up under the same job
 * on the profitability dashboard.
 *
 * Two things this deliberately does NOT do (20261073):
 *   - it never writes the requested completion date into `valid_until`. That
 *     column means "this offer lapses on", and the accept gate acts on it.
 *   - it never touches the job's dates. An extension of time is recorded as
 *     requested/agreed and surfaced; whether it moves the programme is a
 *     product decision nobody has made, so nothing is proposed automatically.
 */
export async function createVariation(jobId: string, formData: FormData) {
  const { user, ctx } = await requireOrgContext();
  await requireCapabilityFor(ctx, user, "quotes", "create"); // R4 — variation is a new quote
  if (!idSchema.safeParse(jobId).success) redirect("/jobs");

  const { variationFormSchema, computeVariation } = await import(
    "@/lib/variations/schema"
  );

  const parsed = variationFormSchema.safeParse({
    title: formData.get("title") ?? "",
    description: formData.get("description") ?? "",
    labour_cost: formData.get("labour_cost") ?? 0,
    materials_cost: formData.get("materials_cost") ?? 0,
    subcontractor_cost: formData.get("subcontractor_cost") ?? 0,
    misc_cost: formData.get("misc_cost") ?? 0,
    margin_pct: formData.get("margin_pct") ?? 0,
    vat_rate: formData.get("vat_rate") ?? 20,
    note: formData.get("note") ?? "",
    eot_requested_completion_date:
      formData.get("eot_requested_completion_date") ?? "",
  });

  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Invalid variation";
    redirect(`/jobs/${jobId}/variations/new?error=${encodeURIComponent(msg)}`);
  }

  const computed = computeVariation(parsed.data);
  const supabase = await createClient();

  // Resolve job: org check + customer_id for the quote FK.
  //
  // The comment said "org check"; the query did not have one. Loading by id
  // alone let a dual-org user raise a variation against another org's job —
  // and because every stamp below was copied from `job.org_id`, the variation
  // quote, its number (drawn from that org's sequence) and its line items were
  // all created THERE. Routed through the same chokepoint the jobs domain got
  // in #456, so a job outside the active org is simply not found.
  const job = await loadJobForOrg<{ id: string; customer_id: string | null }>(
    supabase,
    jobId,
    ctx.org.id,
    "id, customer_id",
  );
  if (!job) redirect("/jobs?error=job_not_found");
  if (!job.customer_id) {
    redirect(`/jobs/${jobId}?error=variation_needs_customer`);
  }

  // Allocate per-org quote number AND per-job variation number.
  const [{ data: quoteNumber }, { data: varNumber }] = await Promise.all([
    supabase.rpc("next_quote_number", { target_org: ctx.org.id }),
    supabase.rpc("next_variation_number", { target_job: jobId }),
  ]);
  if (!quoteNumber || !varNumber) {
    console.error("[variations] number allocation failed", { quoteNumber, varNumber });
    redirect(`/jobs/${jobId}/variations/new?error=create_failed`);
  }

  const publicToken = crypto.randomUUID();

  // Insert the variation as a quote.
  const { data: variation, error: qErr } = await supabase
    .from("quotes")
    .insert({
      org_id: ctx.org.id,
      customer_id: job.customer_id,
      lead_id: null,
      job_id: jobId,
      variation_number: varNumber,
      number: quoteNumber as unknown as string,
      status: "draft",
      currency: "GBP",
      subtotal: computed.subtotal,
      vat_total: computed.vat_total,
      total: computed.total,
      notes: parsed.data.description
        ? `${parsed.data.title}\n\n${parsed.data.description}${parsed.data.note ? `\n\n${parsed.data.note}` : ""}`.trim()
        : `${parsed.data.title}${parsed.data.note ? `\n\n${parsed.data.note}` : ""}`.trim(),
      terms: null,
      // valid_until is the QUOTE EXPIRY and nothing else.
      //
      // This used to be `parsed.data.target_completion_date` — the extension-of-
      // time date the form asks for. Two unrelated commercial meanings shared one
      // column, and the expiry meaning is the one the system acts on:
      // acceptQuoteByToken force-writes status='expired' once valid_until is
      // past, so a variation asking "please let us finish by 30 Sept" became
      // un-acceptable on 1 Oct with no operator action; meanwhile the PDF and the
      // customer portal printed that date as "Valid until". The EoT request now
      // lives in eot_requested_completion_date (20261073) and a variation carries
      // no expiry unless an operator sets a real one on the quote.
      valid_until: null,
      eot_requested_completion_date:
        parsed.data.eot_requested_completion_date ?? null,
      // The priced cost basis. computeVariation() derived revenue from these and
      // then only used them to apportion line-item unit_price, so the margin the
      // business priced this variation at was unrecoverable the instant it was
      // saved (subtotal alone cannot yield it). cost_total is GENERATED from
      // these four, and margin stays derived — one number per fact.
      cost_labour: computed.cost_breakdown.labour,
      cost_materials: computed.cost_breakdown.materials,
      cost_subcontractors: computed.cost_breakdown.subcontractors,
      cost_misc: computed.cost_breakdown.misc,
      public_token: publicToken,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (qErr || !variation) {
    console.error("[variations] insert failed", qErr);
    redirect(`/jobs/${jobId}/variations/new?error=create_failed`);
  }

  // Build customer-facing line items from the cost breakdown. We split
  // the variation revenue across buckets in proportion to their costs
  // so the customer sees a meaningful breakdown rather than a single
  // opaque "variation" line.
  const { labour, materials, subcontractors, misc } = computed.cost_breakdown;
  const totalCost = computed.total_cost;

  // THE COST BASIS IS ALREADY PERSISTED, on the quote itself (cost_labour …
  // cost_misc above, 20261073). There is deliberately NO second per-variation
  // cost store: `quotes.cost_total` is GENERATED from those four, so parts and
  // total cannot drift, and a job budget READS it rather than re-keying it
  // (lib/jobs/budget.ts). Two cost bases for one variation would be two
  // commercial truths, and the one that went stale would be invisible.
  //
  // THE ACCOUNTING BOUNDARY: those columns are a PLAN. They are NOT a cost and
  // never reach `finances` — the real spend lands there when the supplier bill
  // is recorded, and posting the estimate too would double-count it.
  type LIRow = { label: string; cost: number };
  const buckets: LIRow[] = [
    { label: "Labour", cost: labour },
    { label: "Materials", cost: materials },
    { label: "Subcontractors", cost: subcontractors },
    { label: "Other", cost: misc },
  ].filter((b) => b.cost > 0);

  let lineItems: LineItemInsert[];
  if (totalCost === 0 || buckets.length === 0) {
    // Fallback: a single line representing the whole revenue.
    lineItems = [
      {
        quote_id: variation.id,
        org_id: ctx.org.id,
        description: parsed.data.title,
        qty: 1,
        unit_price: computed.subtotal,
        vat_rate: parsed.data.vat_rate,
        line_total: computed.subtotal,
        sort_order: 0,
      },
    ];
  } else {
    lineItems = buckets.map((b, idx) => {
      const share = b.cost / totalCost;
      const unit_price = Math.round(computed.subtotal * share * 100) / 100;
      return {
        quote_id: variation.id,
        org_id: ctx.org.id,
        description: b.label,
        qty: 1,
        unit_price,
        vat_rate: parsed.data.vat_rate,
        line_total: unit_price,
        sort_order: idx,
      };
    });
    // Adjust the last line to ensure sum == computed.subtotal (rounding).
    const summed = lineItems.reduce((s, l) => s + Number(l.unit_price ?? 0), 0);
    const delta = Math.round((computed.subtotal - summed) * 100) / 100;
    if (delta !== 0 && lineItems.length > 0) {
      const last = lineItems[lineItems.length - 1]!;
      last.unit_price = Math.round((Number(last.unit_price ?? 0) + delta) * 100) / 100;
      last.line_total = last.unit_price;
    }
  }

  const { error: liErr } = await supabase
    .from("quote_line_items")
    .insert(lineItems);
  if (liErr) {
    console.error("[variations] line items insert failed", liErr);
    redirect(`/jobs/${jobId}?error=variation_line_items_failed`);
  }

  // G2 convert hook: when this VO was raised FROM an accepted variation
  // request (/jobs/[id]/variations/new?fromRequest=… plants the hidden field),
  // stamp that request 'converted' with this quote's id — closing the
  // intake → decision → priced-VO trail. Best-effort AND fail-closed on
  // identity: the update is pinned to the active org + THIS job + status
  // 'accepted' (the only status the DB trigger lets convert), so a forged or
  // stale id no-ops rather than corrupting another request. A failure here
  // never unwinds the VO — the request can be reconciled later; the money
  // must not vanish because a bookkeeping stamp raced.
  const variationRequestId = formData.get("variation_request_id");
  if (
    typeof variationRequestId === "string" &&
    idSchema.safeParse(variationRequestId).success
  ) {
    await markVariationRequestConverted(supabase, {
      requestId: variationRequestId,
      orgId: ctx.org.id,
      jobId,
      quoteId: variation.id,
    });
  }

  revalidatePath(`/jobs/${jobId}`);
  revalidatePath(`/quotes/${variation.id}`);
  redirect(`/quotes/${variation.id}?saved=variation_created`);
}

/**
 * Stamp a variation request 'converted' after its VO was created (G2).
 *
 * NOT exported (this is a "use server" module — exports must be actions) and
 * never the enforcement: the DB trigger tg_variation_requests_guard is what
 * actually guarantees only accepted→converted with a quote id. The
 * `.eq("status", "accepted")` predicate makes the common non-accepted case a
 * silent no-op instead of a trigger error, and `.eq("job_id", …)` refuses a
 * request id borrowed from a different job.
 */
async function markVariationRequestConverted(
  supabase: Awaited<ReturnType<typeof createClient>>,
  input: { requestId: string; orgId: string; jobId: string; quoteId: string },
): Promise<void> {
  // variation_requests post-dates the generated types (snags idiom).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as unknown as { from: (t: string) => any };
  const { data, error } = await db
    .from("variation_requests")
    .update({ status: "converted", variation_quote_id: input.quoteId })
    .eq("id", input.requestId)
    .eq("org_id", input.orgId)
    .eq("job_id", input.jobId)
    .eq("status", "accepted")
    .select("id");
  if (error) {
    console.error("[variations] convert-stamp failed", error);
  } else if (!data || data.length === 0) {
    console.warn(
      "[variations] convert-stamp matched no accepted request — request id stale or not accepted",
      { requestId: input.requestId },
    );
  }
}

/**
 * Load a variation (a quote with a variation_number) inside the ACTIVE org.
 *
 * Same chokepoint discipline as loadJobForOrg: a variation belonging to another
 * org the viewer also happens to be a member of must be INDISTINGUISHABLE from
 * one that does not exist, so `.eq("id", …)` alone is never enough. Both EoT
 * writers below go through this, and both re-assert the org on the UPDATE too —
 * the read proves ownership, the write predicate is what actually scopes it.
 */
async function loadVariationForOrg(
  supabase: Awaited<ReturnType<typeof createClient>>,
  quoteId: string,
  orgId: string,
): Promise<
  | {
      id: string;
      job_id: string | null;
      variation_number: number | null;
      valid_until: string | null;
      eot_requested_completion_date: string | null;
    }
  | null
> {
  const { data, error } = await supabase
    .from("quotes")
    .select(
      "id, job_id, variation_number, valid_until, eot_requested_completion_date",
    )
    .eq("id", quoteId)
    .eq("org_id", orgId)
    .maybeSingle();
  // A failed read must never be silently treated as "not a variation" — that
  // would show the caller a generic not-found for what is really an outage.
  if (error) throw readFailure("variations: load for EoT write", error);
  if (!data || data.variation_number == null) return null;
  return data;
}

/**
 * Record the AGREED extension of time on a variation.
 *
 * An EoT is agreed AFTER the variation's money is accepted, which is why this
 * is its own action rather than a field on the create form, and why the
 * accepted-document freeze (20261073) deliberately leaves the agreed columns
 * writable while freezing the requested one.
 *
 * IT DOES NOT MOVE THE JOB. Nothing here writes to `jobs`. Under JCT/NEC an
 * agreed extension changes the completion date for damages purposes without
 * necessarily re-baselining the works programme, so auto-applying it would
 * silently re-date live jobs on a guess. The agreed date is stored and shown;
 * re-planning stays a human act.
 */
export async function recordVariationEotAgreement(
  quoteId: string,
  formData: FormData,
) {
  const { user, ctx } = await requireOrgContext();
  await requireCapabilityFor(ctx, user, "quotes", "edit"); // R4 — record EoT agreement
  if (!idSchema.safeParse(quoteId).success) redirect("/quotes");

  // Recording an agreed contractual date is an owner/admin act, matching how
  // quote approval and deletion are gated.
  const role = ctx.membership.role;
  if (role !== "owner" && role !== "admin") {
    redirect(`/quotes/${quoteId}?error=eot_forbidden`);
  }

  const { variationEotAgreementSchema } = await import("@/lib/variations/schema");
  const parsed = variationEotAgreementSchema.safeParse({
    eot_agreed_completion_date:
      formData.get("eot_agreed_completion_date") ?? "",
  });
  if (!parsed.success) {
    redirect(`/quotes/${quoteId}?error=eot_bad_date`);
  }

  const supabase = await createClient();
  const variation = await loadVariationForOrg(supabase, quoteId, ctx.org.id);
  if (!variation) redirect("/quotes?error=not_found");

  const { error } = await supabase
    .from("quotes")
    .update({
      eot_agreed_completion_date: parsed.data.eot_agreed_completion_date,
      eot_agreed_at: new Date().toISOString(),
      eot_agreed_by: user.id,
    })
    .eq("id", quoteId)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[variations] EoT agreement write failed", error);
    redirect(`/quotes/${quoteId}?error=eot_failed`);
  }

  if (variation.job_id) revalidatePath(`/jobs/${variation.job_id}`);
  revalidatePath(`/quotes/${quoteId}`);
  redirect(`/quotes/${quoteId}?saved=eot_agreed`);
}

/**
 * Per-row remediation for the pre-20261073 defect.
 *
 * Variations created before this fix stored their requested completion date in
 * `valid_until`. Those rows cannot be told apart from a variation where an
 * operator later set a GENUINE expiry — there is no column-level history, and
 * the builder pre-fills its "Valid until" input from the same column, so an
 * operator editing anything else re-submitted the misfiled date unchanged. A
 * bulk UPDATE would therefore relabel some real expiries, so the migration
 * refuses to guess and this action lets the person who raised the variation
 * decide, one row at a time.
 *
 * Legal on an accepted variation: the write-once clause permits NULL→value on
 * the requested date, and `valid_until` has never been a frozen column.
 */
export async function reclassifyVariationValidUntilAsEot(quoteId: string) {
  const { ctx, user } = await requireOrgContext();
  await requireCapabilityFor(ctx, user, "quotes", "edit"); // R4
  if (!idSchema.safeParse(quoteId).success) redirect("/quotes");

  const role = ctx.membership.role;
  if (role !== "owner" && role !== "admin") {
    redirect(`/quotes/${quoteId}?error=eot_forbidden`);
  }

  const supabase = await createClient();
  const variation = await loadVariationForOrg(supabase, quoteId, ctx.org.id);
  if (!variation) redirect("/quotes?error=not_found");

  // Only the exact legacy signature is reclassifiable: a date in valid_until
  // and nothing yet recorded as an EoT request. Anything else and we would be
  // overwriting a date somebody deliberately put somewhere.
  if (!variation.valid_until || variation.eot_requested_completion_date) {
    redirect(`/quotes/${quoteId}?error=eot_not_reclassifiable`);
  }

  const { error } = await supabase
    .from("quotes")
    .update({
      eot_requested_completion_date: variation.valid_until,
      valid_until: null,
    })
    .eq("id", quoteId)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[variations] EoT reclassify failed", error);
    redirect(`/quotes/${quoteId}?error=eot_failed`);
  }

  if (variation.job_id) revalidatePath(`/jobs/${variation.job_id}`);
  revalidatePath(`/quotes/${quoteId}`);
  redirect(`/quotes/${quoteId}?saved=eot_reclassified`);
}
