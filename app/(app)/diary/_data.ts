import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";

/**
 * Server-only data helpers for the diary pages.
 *
 * This used to rely on RLS alone ("fetched under the user JWT so RLS does the
 * org scoping"). That is wrong for a member of more than one organisation:
 * `current_org_ids()` returns EVERY org the viewer belongs to, so the job picker
 * offered the OTHER company's jobs — and `site_diary_entries.job_id` has no
 * cross-org guard, so picking one filed this org's diary entry against another
 * org's job. Callers pass the ACTIVE org explicitly (#456 convention).
 */

export type JobOption = { id: string; label: string };

export async function listJobOptions(orgId: string): Promise<JobOption[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("jobs")
    .select("id, status, scheduled_date, customer:customers ( name )")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw readFailure("diary: job options", error);
  return (data ?? []).map((j) => ({
    id: j.id,
    label:
      (j.customer?.name ?? "Job") +
      (j.scheduled_date ? ` · ${j.scheduled_date}` : "") +
      (j.status ? ` · ${j.status}` : ""),
  }));
}
