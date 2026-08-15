"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { readFailure } from "@/lib/supabase/read-failure";

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
