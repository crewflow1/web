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

/**
 * Lead pipeline server actions.
 *
 * Stage transitions live on leads.status (free-text). last_activity_at is
 * bumped on every move so the pipeline view can sort recent activity.
 *
 * RLS-scoped via the user-context client — members CRUD, admins DELETE
 * (per the org-wide policy set in 20260515150000).
 */

const idSchema = z.string().uuid();

function parseCreate(formData: FormData) {
  return createLeadSchema.safeParse({
    source: formData.get("source") ?? "phone",
    service: formData.get("service") ?? "",
    urgency: formData.get("urgency") ?? "normal",
    postcode: formData.get("postcode") ?? "",
    customer_id: formData.get("customer_id") ?? "",
    assigned_to: formData.get("assigned_to") ?? "",
    estimated_value: formData.get("estimated_value") ?? "",
    notes: formData.get("notes") ?? "",
    ai_summary: formData.get("ai_summary") ?? "",
  });
}

function parseUpdate(formData: FormData) {
  return updateLeadSchema.safeParse({
    source: formData.get("source") ?? undefined,
    service: formData.get("service") ?? "",
    urgency: formData.get("urgency") ?? undefined,
    postcode: formData.get("postcode") ?? "",
    customer_id: formData.get("customer_id") ?? "",
    assigned_to: formData.get("assigned_to") ?? "",
    estimated_value: formData.get("estimated_value") ?? "",
    notes: formData.get("notes") ?? "",
    ai_summary: formData.get("ai_summary") ?? "",
  });
}

export async function createLead(formData: FormData) {
  const { ctx } = await requireOrgContext();
  const parsed = parseCreate(formData);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Invalid lead";
    redirect(`/leads/new?error=${encodeURIComponent(msg)}`);
  }

  const now = new Date().toISOString();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("leads")
    .insert({
      org_id: ctx.org.id,
      source: parsed.data.source,
      service: parsed.data.service ?? null,
      urgency: parsed.data.urgency ?? "normal",
      postcode: parsed.data.postcode ?? null,
      customer_id: parsed.data.customer_id ?? null,
      assigned_to: parsed.data.assigned_to ?? null,
      estimated_value: parsed.data.estimated_value ?? null,
      notes: parsed.data.notes ?? null,
      ai_summary: parsed.data.ai_summary ?? null,
      status: "new",
      first_contact_at: now,
      last_activity_at: now,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("[leads] create failed", error);
    redirect("/leads/new?error=create_failed");
  }
  revalidatePath("/leads");
  redirect(`/leads/${data.id}`);
}

export async function updateLead(id: string, formData: FormData) {
  await requireOrgContext();
  if (!idSchema.safeParse(id).success) redirect("/leads");

  const parsed = parseUpdate(formData);
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message ?? "Invalid lead";
    redirect(`/leads/${id}?error=${encodeURIComponent(msg)}`);
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("leads")
    .update({
      source: parsed.data.source ?? undefined,
      service: parsed.data.service ?? null,
      urgency: parsed.data.urgency ?? undefined,
      postcode: parsed.data.postcode ?? null,
      customer_id: parsed.data.customer_id ?? null,
      assigned_to: parsed.data.assigned_to ?? null,
      estimated_value: parsed.data.estimated_value ?? null,
      notes: parsed.data.notes ?? null,
      ai_summary: parsed.data.ai_summary ?? null,
      last_activity_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) {
    console.error("[leads] update failed", error);
    redirect(`/leads/${id}?error=update_failed`);
  }
  revalidatePath("/leads");
  revalidatePath(`/leads/${id}`);
  redirect(`/leads/${id}?saved=1`);
}

/**
 * Quick-move stage from anywhere (card on /leads OR the detail page).
 * Bumps last_activity_at so the recency sort surfaces it.
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
  const { error } = await supabase.from("leads").delete().eq("id", id);
  if (error) {
    console.error("[leads] delete failed", error);
    redirect(`/leads/${id}?error=delete_failed`);
  }
  revalidatePath("/leads");
  redirect("/leads");
}
