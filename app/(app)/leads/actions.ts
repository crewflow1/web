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
  const { data, error } = await supabase
    .from("leads")
    .insert({
      org_id: ctx.org.id,
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
    })
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
      },
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
