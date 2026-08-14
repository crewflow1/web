import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";

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

type JobPickerRow = {
  id: string;
  status: string | null;
  scheduled_date: string | null;
  customer: { name: string | null } | null;
};

/**
 * PAGED (F-1 picker-completion class). This feeds the diary job <select> on
 * both diary/new (preset) and diary/[id]/edit (re-render of the SAVED job_id).
 * The old 200-row cap silently dropped every job older than the 200 newest, so
 * an out-of-cap saved job was absent from the list — the picker then fell to the
 * empty "No job" option and an untouched save NULLed the diary entry's job link.
 * Page the complete set on a stable, unique order (created_at desc + id desc
 * tiebreaker) so no row shifts across a page boundary and every job is offered.
 * Mirrors delays/_data.ts (C70-E). (_form.tsx also preserve-injects the saved
 * job_id — belt-and-braces.)
 */
export async function listJobOptions(orgId: string): Promise<JobOption[]> {
  const supabase = await createClient();
  const { data, error } = await fetchAllRows<JobPickerRow>((from, to) =>
    supabase
      .from("jobs")
      .select("id, status, scheduled_date, customer:customers ( name )")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to) as unknown as PromiseLike<{ data: JobPickerRow[] | null; error: unknown }>,
  );
  if (error) throw readFailure("diary: job options", error as SupabaseReadError);
  return (data ?? []).map((j) => ({
    id: j.id,
    label:
      (j.customer?.name ?? "Job") +
      (j.scheduled_date ? ` · ${j.scheduled_date}` : "") +
      (j.status ? ` · ${j.status}` : ""),
  }));
}
