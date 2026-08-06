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
