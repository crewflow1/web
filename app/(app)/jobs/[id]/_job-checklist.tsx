import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { reportReadFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { listStaffForOrg } from "../_form-helpers";
import { ChecklistClient, type ChecklistItem } from "./_checklist-client";

/**
 * Job checklist panel — the crew's run-list with completion tracking (migration
 * 20261132000000). Distinct from snags (defects) and the ITP quality plan
 * (controlled inspections). The panel owns its ACTIVE-org-pinned read, reads
 * loudly, and renders an explicit error block rather than a quiet nothing.
 *
 * A job's checklist is bounded (a handful to dozens of items per job), so the
 * single job-scoped read is not F-1 truncation-prone; it is still org-pinned.
 */

export async function JobChecklistSection({ jobId }: { jobId: string }) {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const tbl = (c: unknown) => (c as { from: (t: string) => any }).from.bind(c);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const [res, staff] = await Promise.all([
    tbl(supabase)("job_checklists")
      .select("id, label, requires_photo, is_done, done_at, sort, assigned_to, due_on")
      .eq("org_id", ctx.org.id)
      .eq("job_id", jobId)
      .order("sort", { ascending: true }),
    // Assignee picker source — org-pinned, complete (F-1). listStaffForOrg reads
    // loudly and throws on error, so a failed staff read fails the whole panel
    // rather than silently offering an empty assignee list.
    listStaffForOrg(ctx.org.id),
  ]);

  if (res.error) {
    reportReadFailure("job hub: checklist", res.error as SupabaseReadError);
    return (
      <section
        id="checklist"
        className="rounded-xl border border-red-200 bg-red-50 p-6 shadow-sm"
      >
        <h2 className="text-base font-semibold text-red-800">Checklist</h2>
        <p className="mt-1 text-sm text-red-700">
          Couldn&apos;t load this job&apos;s checklist. This panel is NOT saying
          there is none — refresh to try again.
        </p>
      </section>
    );
  }

  const items = (res.data ?? []) as ChecklistItem[];
  return <ChecklistClient jobId={jobId} initialItems={items} staff={staff} />;
}
