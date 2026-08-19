"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import {
  createLeadSchema,
  updateLeadSchema,
  moveStageSchema,
} from "@/lib/leads/schema";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";
import { verifyCrmReferences } from "@/lib/crm/reference-integrity";
import {
  decideConversion,
  buildCustomerFromLead,
  type ConvertibleLead,
} from "@/lib/leads/convert";
import { recomputeLeadScore } from "@/server/services/lead-score";

/**
 * Lead pipeline server actions.
 *
 * Stage transitions live on leads.status (free-text). last_activity_at is
 * bumped on every move so the pipeline view can sort recent activity.
 *
 * RLS-scoped via the user-context client — members CRUD, admins DELETE
 * (per the org-wide policy set in 20260515150000).
 *
 * RLS is the OUTER boundary only. `current_org_ids()` returns every org the
 * viewer belongs to, so by-id writes must ALSO carry `.eq("org_id",
 * ctx.org.id)` or a dual-org user working in org A can edit, re-stage or
 * delete org B's leads from A's pipeline. Zero rows affected surfaces as the
 * existing "no permission" / "denied" outcome.
 */

type LeadValues = Record<string, unknown>;

const idSchema = z.string().uuid();

export async function createLead(
  _prevState: FormState<LeadValues>,
  formData: FormData,
): Promise<FormState<LeadValues>> {
  const { ctx } = await requireOrgContext();
  const result = validateFormData(formData, createLeadSchema);
  if (!result.ok) return result.state as FormState<LeadValues>;

  const now = new Date().toISOString();
  const supabase = await createClient();

  // Cross-tenant reference integrity (defence in depth over the DB composite FK
  // + membership trigger from 20261112000000): a caller must not attach another
  // org's customer or a non-member as the assignee. Clean validation error, not a 500.
  const refs = await verifyCrmReferences(supabase, ctx.org.id, {
    customerId: result.data.customer_id ?? null,
    assignedTo: result.data.assigned_to ?? null,
  });
  if (!refs.ok) return formError(refs.message, result.data as LeadValues);

  // contact_name/email/phone columns landed in migration
  // 20260601000100_leads_contact_fields and aren't yet in the generated
  // Supabase types — the `as never` keeps the typed client happy until
  // `pnpm db:generate` next runs.
  const { data, error } = await supabase
    .from("leads")
    .insert({
      org_id: ctx.org.id,
      contact_name: result.data.contact_name,
      contact_email: result.data.contact_email ?? null,
      contact_phone: result.data.contact_phone ?? null,
      source: result.data.source,
      service: result.data.service ?? null,
      urgency: result.data.urgency ?? "normal",
      postcode: result.data.postcode ?? null,
      customer_id: result.data.customer_id ?? null,
      assigned_to: result.data.assigned_to ?? null,
      estimated_value: result.data.estimated_value ?? null,
      notes: result.data.notes ?? null,
      ai_summary: result.data.ai_summary ?? null,
      status: "new",
      first_contact_at: now,
      last_activity_at: now,
    } as never)
    .select("id")
    .single();

  if (error || !data) {
    console.error("[leads] create failed", error);
    return formError("Couldn't save the lead. Try again.", result.data as LeadValues);
  }
  // Refresh the lead-score cache from the row as just written (non-fatal on
  // failure — the pipeline + detail pages compute the score live regardless).
  await recomputeLeadScore(supabase, ctx.org.id, data.id);
  revalidatePath("/leads");
  return formSuccess({
    successMessage: "Lead saved.",
    redirectTo: `/leads/${data.id}`,
  });
}

export async function updateLead(
  id: string,
  _prevState: FormState<LeadValues>,
  formData: FormData,
): Promise<FormState<LeadValues>> {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) return formError("Invalid lead id.");

  const result = validateFormData(formData, updateLeadSchema);
  if (!result.ok) return result.state as FormState<LeadValues>;

  const supabase = await createClient();

  // Cross-tenant reference integrity — see createLead. Verified before the write.
  const refs = await verifyCrmReferences(supabase, ctx.org.id, {
    customerId: result.data.customer_id ?? null,
    assignedTo: result.data.assigned_to ?? null,
  });
  if (!refs.ok) return formError(refs.message, result.data as LeadValues);

  const { error, count } = await supabase
    .from("leads")
    .update(
      {
        contact_name: result.data.contact_name,
        contact_email: result.data.contact_email ?? null,
        contact_phone: result.data.contact_phone ?? null,
        source: result.data.source ?? undefined,
        service: result.data.service ?? null,
        urgency: result.data.urgency ?? undefined,
        postcode: result.data.postcode ?? null,
        customer_id: result.data.customer_id ?? null,
        assigned_to: result.data.assigned_to ?? null,
        estimated_value: result.data.estimated_value ?? null,
        notes: result.data.notes ?? null,
        ai_summary: result.data.ai_summary ?? null,
        last_activity_at: new Date().toISOString(),
      } as never,
      { count: "exact" },
    )
    .eq("id", id)
    // Active-org scope — see the module note.
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[leads] update failed", error);
    return formError("Couldn't save changes. Try again.", result.data as LeadValues);
  }
  if (count === 0) {
    return formError(
      "You don't have permission to edit this lead.",
      result.data as LeadValues,
    );
  }
  // The edit changed scoring inputs (value / source / contact / customer link),
  // so refresh the score cache from the persisted row.
  await recomputeLeadScore(supabase, ctx.org.id, id);
  revalidatePath("/leads");
  revalidatePath(`/leads/${id}`);
  return formSuccess({ successMessage: "Lead updated." });
}

/**
 * Quick-move stage from anywhere (card on /leads OR the detail page).
 * Bumps last_activity_at so the recency sort surfaces it.
 *
 * Button-only — keeps redirect+querystring pattern.
 */
export async function moveLeadStage(id: string, formData: FormData) {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/leads");

  const parsed = moveStageSchema.safeParse({
    status: formData.get("status") ?? "",
  });
  if (!parsed.success) {
    redirect("/leads?error=invalid_stage");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("leads")
    .update({
      status: parsed.data.status,
      last_activity_at: new Date().toISOString(),
    })
    // Active-org scope — see the module note.
    .eq("id", id)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[leads] stage move failed", error);
    redirect(`/leads/${id}?error=move_failed`);
  }
  // Stage is a scoring factor — refresh the cache after the move.
  await recomputeLeadScore(supabase, ctx.org.id, id);
  revalidatePath("/leads");
  revalidatePath(`/leads/${id}`);
  redirect(`/leads`);
}

/**
 * Phase B — Owner acknowledgement of a lead.
 *
 * Records the action (call / message / archive) on
 * lead_followup_state.acted_*, which the cron uses to stop firing
 * reminders. Archive also moves the lead status to `archived`.
 */
const ACTED_KIND_SCHEMA = z.enum(["call", "message", "archive"]);

export async function acknowledgeLead(id: string, formData: FormData) {
  const { ctx, user } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/leads?error=bad_id");

  const parsed = ACTED_KIND_SCHEMA.safeParse(formData.get("kind") ?? "");
  if (!parsed.success) redirect(`/leads/${id}?error=bad_kind`);

  // SECURITY (P2 audit M-2): markLeadActed writes lead_followup_state via the
  // SERVICE-ROLE admin client, which BYPASSES RLS, and stamps the row with
  // the caller's OWN org_id — so the org-scoped lead_followup_state policies
  // (org_id in current_org_ids(), migration 20260623000000) can never reject
  // a foreign lead_id. Without an explicit ownership check a member who knows
  // another org's lead id could acknowledge it, silently suppressing that
  // org's 72h/7d follow-up reminders and corrupting its state row. Confirm the
  // lead is in this org on the RLS-scoped tenant client BEFORE any admin write.
  const supabase = await createClient();
  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("id")
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  // Fail loud on a rejected read — falling through to not_found here would let
  // a transient failure masquerade as a missing lead.
  if (leadError) throw readFailure("lead acknowledge: lead", leadError);
  if (!lead) redirect(`/leads/${id}?error=not_found`);

  const { markLeadActed } = await import("@/server/services/lead-followups");
  await markLeadActed({
    lead_id: id,
    org_id: ctx.org.id,
    kind: parsed.success ? parsed.data : "call",
    acted_by_user_id: user.id,
  });

  // Archive also moves the lead status so it drops out of pipeline view.
  // Both writes restate the org predicate: the resolve-then-redirect above
  // already gates them, but a write that carries its own scope cannot be
  // broken by a later edit to the guard.
  if (parsed.success && parsed.data === "archive") {
    await supabase
      .from("leads")
      .update({
        status: "archived",
        last_activity_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("org_id", ctx.org.id);
  } else {
    // Otherwise just bump last_activity_at so recency sorts still work.
    await supabase
      .from("leads")
      .update({ last_activity_at: new Date().toISOString() })
      .eq("id", id)
      .eq("org_id", ctx.org.id);
  }

  // NB: deliberately NOT rescoring here. Acknowledge only nudges recency (a
  // small factor) and, on archive, removes the lead from the pipeline entirely —
  // where its cached score no longer matters. The pipeline + detail pages
  // compute the score LIVE, so the display stays correct regardless, and the
  // cache is refreshed on the next scoring-input edit (save / stage move). This
  // keeps acknowledge's single-write footprint (and its ownership-gate invariant)
  // exactly as audited.

  revalidatePath("/leads");
  revalidatePath(`/leads/${id}`);
  redirect(`/leads/${id}?saved=acknowledged`);
}

/**
 * Phase C — Regenerate the AI summary for a lead.
 *
 * Calls summariseLead() and persists the result to leads.ai_summary so
 * the next page render shows it. Suggested action goes into the same
 * field as a postfix (the leads table doesn't have a dedicated column).
 */
export async function regenerateLeadSummary(id: string) {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/leads?error=bad_id");

  // SECURITY (P2 audit H-1): summariseLead reads via the service-role admin
  // client (RLS bypassed), so it MUST be scoped to the caller's org. Pass
  // ctx.org.id; a foreign-org lead returns null and we redirect below
  // without sending PII to the LLM or persisting anything.
  const { summariseLead } = await import("@/server/services/lead-summary");
  const result = await summariseLead(id, ctx.org.id);
  if (!result) {
    redirect(`/leads/${id}?error=summary_failed`);
  }

  const composed = result.suggested_action
    ? `${result.summary}\n\nSuggested next step: ${result.suggested_action}.`
    : result.summary;

  const supabase = await createClient();
  await supabase
    .from("leads")
    .update({
      ai_summary: composed,
      last_activity_at: new Date().toISOString(),
    })
    .eq("id", id)
    // Restates the scope summariseLead() already enforced above.
    .eq("org_id", ctx.org.id);

  revalidatePath(`/leads/${id}`);
  redirect(`/leads/${id}?saved=summary_regenerated`);
}

/**
 * Convert a lead into a customer.
 *
 * Creates a NEW customer from the lead's contact fields (name/email/phone) and
 * backfills leads.customer_id so the lead and the customer are linked. This is
 * the "this enquiry is now a real client" moment.
 *
 * IDEMPOTENT, on purpose. A double-click, a retried POST, or a race between two
 * staff must never mint two customers for one lead:
 *   1. The lead is read ACTIVE-org pinned. A lead in another org is
 *      indistinguishable from a missing one (RLS admits every org the caller
 *      belongs to — the pin is the real scope).
 *   2. If leads.customer_id is ALREADY set, this is a no-op: we redirect to the
 *      EXISTING customer rather than creating another (the idempotency guard).
 *   3. Otherwise we create the customer, then backfill customer_id ONLY WHERE it
 *      is still null (`.is("customer_id", null)`). If a concurrent conversion won
 *      that race (count === 0), we delete the customer we just created (an
 *      orphan) and send the user to the winner — so the invariant "one lead → at
 *      most one converted customer" holds even under concurrency.
 *
 * Button-only (redirect + querystring, no useActionState) — matches the other
 * lifecycle actions in this file and sidesteps the deep-swap commit race.
 */
export async function convertLeadToCustomer(id: string) {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/leads?error=bad_id");

  const supabase = await createClient();

  // contact_* + customer_id, ACTIVE-org pinned. contact_* aren't in the
  // generated types yet (20260601000100) — string selector + unknown-cast.
  const { data: leadRaw, error: leadError } = await supabase
    .from("leads")
    .select("id, customer_id, contact_name, contact_email, contact_phone" as never)
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (leadError) throw readFailure("lead convert: lead", leadError);
  if (!leadRaw) redirect(`/leads/${id}?error=not_found`);
  const lead = leadRaw as unknown as ConvertibleLead;

  const decision = decideConversion(lead);
  // Already converted → return the existing customer (idempotent no-op).
  if (decision.kind === "already") {
    redirect(`/customers/${decision.customerId}?saved=lead_converted`);
  }
  if (decision.kind === "no_contact") {
    redirect(`/leads/${id}?error=convert_no_contact`);
  }

  const { data: created, error: createError } = await supabase
    .from("customers")
    .insert(buildCustomerFromLead(ctx.org.id, decision.name, lead))
    .select("id")
    .single();
  if (createError || !created) {
    console.error("[leads] convert: customer create failed", createError);
    redirect(`/leads/${id}?error=convert_failed`);
  }

  // Backfill ONLY while still unconverted — the concurrency guard. `count`
  // distinguishes "we linked it" from "someone else already did".
  const { error: linkError, count } = await supabase
    .from("leads")
    .update(
      {
        customer_id: created.id,
        last_activity_at: new Date().toISOString(),
      } as never,
      { count: "exact" },
    )
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .is("customer_id", null);
  if (linkError) {
    console.error("[leads] convert: backfill failed", linkError);
    // Roll back the orphan customer so a failed link can't strand a record.
    await supabase.from("customers").delete().eq("id", created.id).eq("org_id", ctx.org.id);
    redirect(`/leads/${id}?error=convert_failed`);
  }
  if (count === 0) {
    // A concurrent conversion won the race. Remove our orphan and send the user
    // to the customer that actually got linked.
    await supabase.from("customers").delete().eq("id", created.id).eq("org_id", ctx.org.id);
    // LOUD read — bind the error rather than discard it; a rejected re-read must
    // not masquerade as "no winner" and silently swallow the concurrent link.
    const { data: winner, error: winnerError } = await supabase
      .from("leads")
      .select("customer_id")
      .eq("id", id)
      .eq("org_id", ctx.org.id)
      .maybeSingle();
    if (winnerError) throw readFailure("lead convert: winner re-read", winnerError);
    const winnerId = (winner as { customer_id: string | null } | null)?.customer_id ?? null;
    if (winnerId) redirect(`/customers/${winnerId}?saved=lead_converted`);
    redirect(`/leads/${id}?error=convert_failed`);
  }

  revalidatePath("/leads");
  revalidatePath(`/leads/${id}`);
  revalidatePath("/customers");
  redirect(`/customers/${created.id}?saved=lead_converted`);
}

export async function deleteLead(id: string) {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/leads");

  const supabase = await createClient();
  const { error, count } = await supabase
    .from("leads")
    .delete({ count: "exact" })
    .eq("id", id)
    // Active-org scope — see the module note. Irreversible, so this is the
    // most important predicate in the file.
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[leads] delete failed", error);
    redirect(`/leads/${id}?error=delete_failed`);
  }
  if (count === 0) {
    redirect(`/leads/${id}?error=delete_denied`);
  }
  revalidatePath("/leads");
  redirect("/leads");
}
