"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";
import {
  templateHeaderSchema,
  TEMPLATE_MILESTONE_ROWS,
  TEMPLATE_CHECKLIST_ROWS,
  type TemplateMilestonePayload,
  type TemplateChecklistPayload,
} from "@/lib/jobs/templates";

/**
 * Job template server actions (migrations 20261132000001).
 *
 * A template is admin planning configuration. The RPC `save_job_template` is
 * SECURITY INVOKER and the RLS is admin-only, so a staff JWT is refused by the
 * database whether it comes through here or /rest/v1 directly — this action adds
 * no second gate to drift out of step. The RPC replaces the child milestone /
 * checklist rows atomically.
 *
 * Delete is a by-id tenant write ACTIVE-org pinned (`.eq("org_id", ctx.org.id)`)
 * so a dual-org admin cannot delete the other org's template — RLS admits every
 * org the caller belongs to, so the pin is the real inner scope.
 */

const idSchema = z.string().uuid();

/** Refusal sentences the RPC authored for a human, surfaced verbatim. */
const RPC_SENTENCES = [
  "a template needs",
  "every milestone needs",
  "milestone \"",
  "a milestone weight must be",
  "that job status is not recognised",
  "that template is not in this workspace",
];

function friendlyRpcError(message: string | undefined): string {
  const m = (message ?? "").trim();
  if (m && RPC_SENTENCES.some((s) => m.includes(s))) return m;
  return "Couldn't save the template. Check the milestones and try again.";
}

type RpcClient = {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

function readMilestones(formData: FormData): TemplateMilestonePayload[] | string {
  const out: TemplateMilestonePayload[] = [];
  for (let i = 1; i <= TEMPLATE_MILESTONE_ROWS; i++) {
    const title = String(formData.get(`milestone_title_${i}`) ?? "").trim();
    if (!title) continue;
    if (title.length > 200) return `Milestone ${i}'s title is too long (200 max).`;
    const endRaw = String(formData.get(`milestone_offset_end_${i}`) ?? "").trim();
    const end = Number(endRaw);
    if (!Number.isInteger(end) || end < 0) {
      return `Milestone "${title}" needs an end offset of 0 or more whole days.`;
    }
    const startRaw = String(formData.get(`milestone_offset_start_${i}`) ?? "").trim();
    let start: number | null = null;
    if (startRaw) {
      const n = Number(startRaw);
      if (!Number.isInteger(n) || n < 0 || n > end) {
        return `Milestone "${title}"'s start offset must be a whole number from 0 to its end.`;
      }
      start = n;
    }
    const weightRaw = String(formData.get(`milestone_weight_${i}`) ?? "").trim();
    let weight: number | null = null;
    if (weightRaw) {
      const n = Number(weightRaw);
      if (!Number.isFinite(n) || n <= 0 || n > 100) {
        return `Milestone "${title}"'s weight must be above 0 and at most 100.`;
      }
      weight = n;
    }
    out.push({
      title,
      offset_start_days: start,
      offset_end_days: end,
      weight,
      customer_visible: formData.get(`milestone_visible_${i}`) === "on",
    });
  }
  return out;
}

function readChecklist(formData: FormData): TemplateChecklistPayload[] {
  const out: TemplateChecklistPayload[] = [];
  for (let i = 1; i <= TEMPLATE_CHECKLIST_ROWS; i++) {
    const label = String(formData.get(`checklist_label_${i}`) ?? "").trim();
    if (!label) continue;
    out.push({
      label: label.slice(0, 300),
      requires_photo: formData.get(`checklist_photo_${i}`) === "on",
    });
  }
  return out;
}

async function saveTemplate(
  templateId: string | null,
  formData: FormData,
): Promise<FormState> {
  const { ctx } = await requireOrgContext();

  const parsed = templateHeaderSchema.safeParse({
    name: formData.get("name") ?? "",
    job_type: formData.get("job_type") ?? "",
    description: formData.get("description") ?? "",
    default_status: formData.get("default_status") ?? "",
  });
  if (!parsed.success) {
    return formError(parsed.error.issues[0]?.message ?? "Check the template details.");
  }

  const milestones = readMilestones(formData);
  if (typeof milestones === "string") return formError(milestones);
  const checklist = readChecklist(formData);

  if (milestones.length === 0 && checklist.length === 0) {
    return formError("A template needs at least one milestone or checklist item.");
  }

  const supabase = (await createClient()) as unknown as RpcClient;
  const { data, error } = await supabase.rpc("save_job_template", {
    p_template_id: templateId,
    p_org_id: ctx.org.id,
    p_name: parsed.data.name,
    p_job_type: parsed.data.job_type ?? null,
    p_description: parsed.data.description ?? null,
    p_default_status: parsed.data.default_status ?? null,
    p_milestones: milestones,
    p_checklist: checklist,
  });

  if (error) {
    console.error("[job-templates] save failed", error);
    return formError(friendlyRpcError(error.message));
  }

  const newId = typeof data === "string" ? data : templateId;
  revalidatePath("/jobs/templates");
  if (newId) revalidatePath(`/jobs/templates/${newId}`);
  return formSuccess({ redirectTo: "/jobs/templates?saved=1" });
}

export async function createJobTemplate(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  return saveTemplate(null, formData);
}

export async function updateJobTemplate(
  templateId: string,
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!idSchema.safeParse(templateId).success) {
    return formError("That template link looks wrong — reload and try again.");
  }
  return saveTemplate(templateId, formData);
}

export async function deleteJobTemplate(templateId: string): Promise<void> {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(templateId).success) {
    redirect("/jobs/templates?error=bad_id");
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("job_templates")
    .delete()
    // ACTIVE-org pin: RLS admits every org the caller belongs to, so this is the
    // real inner scope preventing a dual-org admin deleting the other org's row.
    .eq("id", templateId)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[job-templates] delete failed", error);
    redirect(`/jobs/templates?error=delete_failed`);
  }
  revalidatePath("/jobs/templates");
  redirect("/jobs/templates?deleted=1");
}
