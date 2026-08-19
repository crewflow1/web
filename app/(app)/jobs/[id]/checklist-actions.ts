"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { readFailure } from "@/lib/supabase/read-failure";
import { verifyAssigneeInOrg } from "@/lib/crm/reference-integrity";
import { emitNotifications } from "@/server/services/notifications-service";

/**
 * Per-job checklist server actions (migration 20261132000000).
 *
 * Checklists are member-writable working lists. Every by-id write is ACTIVE-org
 * pinned (`.eq("org_id", ctx.org.id)`) in-statement — RLS admits every org the
 * caller belongs to, so the pin is the real inner scope. Completion provenance
 * (done_by / done_at) is stamped by a DB trigger from the is_done transition,
 * never trusted from the client, so these actions only ever write is_done.
 *
 * These return plain `{ ok, error }` results and revalidate the job route; the
 * client (_job-checklist.tsx) calls them inside a transition and refreshes, so
 * there is no redirect()/router.push and thus no deep-swap commit race.
 */

export type ChecklistResult = { ok: boolean; error?: string };

const idSchema = z.string().uuid();
const labelSchema = z.string().trim().min(1).max(300);

export async function addChecklistItem(
  jobId: string,
  label: string,
): Promise<ChecklistResult> {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(jobId).success) return { ok: false, error: "Bad job." };
  const parsedLabel = labelSchema.safeParse(label);
  if (!parsedLabel.success) return { ok: false, error: "Enter a checklist step (1–300 characters)." };

  const supabase = await createClient();

  // The job must be in the active org (structural belt over the composite FK).
  const { data: job, error: jobError } = await supabase
    .from("jobs")
    .select("id")
    .eq("id", jobId)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (jobError) throw readFailure("job checklist: job", jobError);
  if (!job) return { ok: false, error: "That job isn't in this workspace." };

  // Next sort = current max + 1 (bounded single-row read; no unique on sort, so
  // concurrent adds are safe).
  const { data: last, error: lastError } = await supabase
    .from("job_checklists")
    .select("sort")
    .eq("org_id", ctx.org.id)
    .eq("job_id", jobId)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastError) throw readFailure("job checklist: max sort", lastError);
  const nextSort = ((last as { sort?: number } | null)?.sort ?? 0) + 1;

  const { error } = await supabase.from("job_checklists").insert({
    org_id: ctx.org.id,
    job_id: jobId,
    label: parsedLabel.data,
    sort: nextSort,
  });
  if (error) {
    console.error("[job-checklist] add failed", error);
    return { ok: false, error: "Couldn't add the item. Try again." };
  }
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

export async function setChecklistItemDone(
  itemId: string,
  done: boolean,
): Promise<ChecklistResult> {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(itemId).success) return { ok: false, error: "Bad item." };
  const supabase = await createClient();
  const { error, count } = await supabase
    .from("job_checklists")
    .update({ is_done: done }, { count: "exact" })
    .eq("id", itemId)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[job-checklist] toggle failed", error);
    return { ok: false, error: "Couldn't update the item. Try again." };
  }
  if (count === 0) return { ok: false, error: "That item isn't in this workspace." };
  // Revalidate the job route — the item's job_id isn't in scope here, so the
  // client refresh() re-fetches the current page anyway; a broad /jobs bust is
  // enough to invalidate any cached job detail.
  revalidatePath("/jobs", "layout");
  return { ok: true };
}

const assignmentSchema = z.object({
  assignedTo: z.union([z.string().uuid(), z.null()]),
  dueOn: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.null()]),
});

/**
 * Assign a checklist item to a person and/or set its due date (migration
 * 20261182000000). Both are optional axes — pass null to clear either.
 *
 * The assignee (when set) MUST be a member of the ACTIVE org: verified here for
 * a clean message, and enforced again by the tg_assignee_is_org_member trigger
 * (the same guard jobs/leads.assigned_to use) so even a crafted payload can't
 * assign a foreign-org user. The by-id write is ACTIVE-org pinned.
 *
 * Completion provenance (done_by/done_at) is untouched — assignment is a
 * different axis (who SHOULD do it) from completion (who ticked it).
 *
 * On a NEW assignment to someone other than the actor we fire a best-effort
 * in-app notification to that person; a notification failure never fails the
 * assignment.
 */
export async function setChecklistAssignment(
  itemId: string,
  assignedTo: string | null,
  dueOn: string | null,
): Promise<ChecklistResult> {
  const { ctx, user } = await requireOrgContext();
  if (!idSchema.safeParse(itemId).success) return { ok: false, error: "Bad item." };
  const parsed = assignmentSchema.safeParse({ assignedTo, dueOn });
  if (!parsed.success) return { ok: false, error: "Pick a valid assignee and date." };

  const supabase = await createClient();

  // Defence in depth over the trigger — clean validation message, not a 500.
  if (parsed.data.assignedTo) {
    const ref = await verifyAssigneeInOrg(supabase, parsed.data.assignedTo, ctx.org.id);
    if (!ref.ok) return { ok: false, error: ref.message };
  }

  // Read the prior assignee (org-pinned) so we only notify on a REAL change and
  // can resolve the item's job for the notification deep-link.
  // assigned_to isn't in the generated types yet (20261182000000) — `as never`
  // selector + unknown-cast, the established new-column read idiom.
  const { data: before, error: beforeError } = await supabase
    .from("job_checklists")
    .select("job_id, label, assigned_to" as never)
    .eq("id", itemId)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (beforeError) throw readFailure("job checklist: assignment prior", beforeError);
  if (!before) return { ok: false, error: "That item isn't in this workspace." };
  const prior = before as unknown as {
    job_id: string;
    label: string;
    assigned_to: string | null;
  };

  const { error, count } = await supabase
    .from("job_checklists")
    .update(
      { assigned_to: parsed.data.assignedTo, due_on: parsed.data.dueOn } as never,
      { count: "exact" },
    )
    .eq("id", itemId)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[job-checklist] assignment failed", error);
    return { ok: false, error: "Couldn't update the assignment. Try again." };
  }
  if (count === 0) return { ok: false, error: "That item isn't in this workspace." };

  // Notify a NEWLY-assigned person (not on a due-date-only edit, not self).
  const assignee = parsed.data.assignedTo;
  if (assignee && assignee !== prior.assigned_to && assignee !== user.id) {
    await emitNotifications([
      {
        org_id: ctx.org.id,
        user_id: assignee, // targeted — only the assignee, not the whole org
        audience: "customer",
        type: "job_checklist.assigned",
        category: "system",
        priority: "medium",
        title: "You've been assigned a task",
        body: prior.label + (parsed.data.dueOn ? ` — due ${parsed.data.dueOn}` : ""),
        action_url: `/jobs/${prior.job_id}#checklist`,
        source_module: "job_checklists",
        source_id: itemId,
        metadata: { job_id: prior.job_id, due_on: parsed.data.dueOn },
      },
    ]).catch((e) => console.error("[job-checklist] assign notify failed", e));
  }

  revalidatePath(`/jobs/${prior.job_id}`);
  revalidatePath("/me");
  return { ok: true };
}

export async function deleteChecklistItem(itemId: string): Promise<ChecklistResult> {
  const { ctx } = await requireOrgContext();
  if (!idSchema.safeParse(itemId).success) return { ok: false, error: "Bad item." };
  const supabase = await createClient();
  const { error, count } = await supabase
    .from("job_checklists")
    .delete({ count: "exact" })
    .eq("id", itemId)
    .eq("org_id", ctx.org.id);
  if (error) {
    console.error("[job-checklist] delete failed", error);
    return { ok: false, error: "Couldn't remove the item. Try again." };
  }
  if (count === 0) return { ok: false, error: "That item isn't in this workspace." };
  revalidatePath("/jobs", "layout");
  return { ok: true };
}
