"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
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

/**
 * Lead pipeline server actions.
 *
 * Stage transitions live on leads.status (free-text). last_activity_at is
 * bumped on every move so the pipeline view can sort recent activity.
 *
 * RLS-scoped via the user-context client — members CRUD, admins DELETE
 * (per the org-wide policy set in 20260515150000).
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
  // contact_name/email/phone columns landed in migration
  // 20260601000000_leads_contact_fields and aren't yet in the generated
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
  await requireOrgContext();
  if (!idSchema.safeParse(id).success) return formError("Invalid lead id.");

  const result = validateFormData(formData, updateLeadSchema);
  if (!result.ok) return result.state as FormState<LeadValues>;

  const supabase = await createClient();
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
    .eq("id", id);
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
  return formSuccess({ successMessage: "Saved." });
}

/**
 * Quick-move stage from anywhere (card on /leads OR the detail page).
 * Bumps last_activity_at so the recency sort surfaces it.
 *
 * Button-only — keeps redirect+querystring pattern.
 */
export async function moveLeadStage(id: string, formData: FormData) {
  await requireOrgContext();
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
    .eq("id", id);
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

  const { markLeadActed } = await import("@/server/services/lead-followups");
  await markLeadActed({
    lead_id: id,
    org_id: ctx.org.id,
    kind: parsed.success ? parsed.data : "call",
    acted_by_user_id: user.id,
  });

  // Archive also moves the lead status so it drops out of pipeline view.
  if (parsed.success && parsed.data === "archive") {
    const supabase = await createClient();
    await supabase
      .from("leads")
      .update({
        status: "archived",
        last_activity_at: new Date().toISOString(),
      })
      .eq("id", id);
  } else {
    // Otherwise just bump last_activity_at so recency sorts still work.
    const supabase = await createClient();
    await supabase
      .from("leads")
      .update({ last_activity_at: new Date().toISOString() })
      .eq("id", id);
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
  await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/leads?error=bad_id");

  const { summariseLead } = await import("@/server/services/lead-summary");
  const result = await summariseLead(id);
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
    .eq("id", id);

  revalidatePath(`/leads/${id}`);
  redirect(`/leads/${id}?saved=summary_regenerated`);
}

export async function deleteLead(id: string) {
  await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/leads");

  const supabase = await createClient();
  const { error, count } = await supabase
    .from("leads")
    .delete({ count: "exact" })
    .eq("id", id);
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
