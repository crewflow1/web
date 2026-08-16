import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { listBlueprintsForOrg, type OrgBlueprintRow } from "@/server/services/blueprints";
import { formatDiaryDate } from "@/lib/site-diary/schema";
import { EmptyState } from "../_components/empty-state";

export const dynamic = "force-dynamic";

export const metadata = { title: "Drawings · CrewFlow" };

/**
 * /blueprints — the top-level Blueprint Centre (the drawing register across
 * every job).
 *
 * The full viewer / compare / markup experience is job-scoped and lives at
 * `/jobs/[id]/blueprints`; this is purely a routing surface — an org-wide index
 * that groups the org's drawings by job and links into each job's register. It
 * reuses the existing service reads and adds NO blueprint logic of its own.
 *
 * ORG-PINNED + LOUD + PAGED: listBlueprintsForOrg pins the active org, pages the
 * complete set (F-1), and throws on a failed read. The job-name lookup is
 * chunked so its `.in(...)` never crosses the PostgREST cap.
 */

type JobGroup = {
  jobId: string;
  count: number;
  /** Most recent drawing update in the group (ISO), for the "last activity" line. */
  latest: string;
};

function groupByJob(rows: readonly OrgBlueprintRow[]): JobGroup[] {
  const byJob = new Map<string, JobGroup>();
  for (const r of rows) {
    if (!r.job_id) continue;
    const g = byJob.get(r.job_id);
    if (g) {
      g.count += 1;
      if (r.updated_at > g.latest) g.latest = r.updated_at;
    } else {
      byJob.set(r.job_id, { jobId: r.job_id, count: 1, latest: r.updated_at });
    }
  }
  // Deterministic: newest activity first, job id as a stable tiebreak.
  return [...byJob.values()].sort((a, b) =>
    a.latest !== b.latest ? (a.latest < b.latest ? 1 : -1) : a.jobId < b.jobId ? -1 : 1,
  );
}

export default async function BlueprintsIndexPage() {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const rows = await listBlueprintsForOrg(ctx.org.id);
  const groups = groupByJob(rows);

  // Batched job labels (customer name + scheduled date). CHUNKED (F-1): the
  // register is fully paged, so the job-id set can exceed the cap; jobs.id is
  // unique so a chunk of N ids yields ≤ N rows.
  const jobLabels = new Map<string, string>();
  const jobIds = groups.map((g) => g.jobId);
  const JOB_IN_CHUNK = 500;
  for (let i = 0; i < jobIds.length; i += JOB_IN_CHUNK) {
    const idsChunk = jobIds.slice(i, i + JOB_IN_CHUNK);
    const { data: jobs, error: jobsError } = await supabase
      .from("jobs")
      .select("id, scheduled_date, customer:customers ( name )")
      .eq("org_id", ctx.org.id)
      .in("id", idsChunk);
    if (jobsError) throw readFailure("blueprints: job labels", jobsError);
    for (const j of jobs ?? []) {
      const parts = [j.customer?.name ?? "Job", j.scheduled_date ?? null].filter(Boolean);
      jobLabels.set(j.id, parts.join(" · "));
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Drawings</h1>
        <p className="mt-1 max-w-2xl text-sm text-slate-600">
          Every drawing set across your jobs, in one place. Open a job to view,
          compare revisions, and mark up on site — the latest revision is always
          the one everyone sees.
        </p>
      </header>

      {groups.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
          <EmptyState
            icon="📐"
            title="No drawings yet"
            body="Drawings live on the job they belong to. Open a job and add its drawing set — every revision is kept, and the newest becomes the current issue."
            primary={{ href: "/jobs", label: "Go to jobs" }}
          />
        </div>
      ) : (
        <>
          <ul className="space-y-3">
            {groups.map((g) => {
              const label = jobLabels.get(g.jobId) ?? "Job";
              return (
                <li
                  key={g.jobId}
                  className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <Link
                        href={`/jobs/${g.jobId}/blueprints`}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        {label}
                      </Link>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {g.count} drawing{g.count === 1 ? "" : "s"} · last updated{" "}
                        <time dateTime={g.latest}>{formatDiaryDate(g.latest.slice(0, 10))}</time>
                      </p>
                    </div>
                    <Link
                      href={`/jobs/${g.jobId}/blueprints`}
                      className="shrink-0 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Open drawings
                    </Link>
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-slate-500">
            {groups.length} job{groups.length === 1 ? "" : "s"} with drawings ·{" "}
            {rows.length} drawing{rows.length === 1 ? "" : "s"} total.
          </p>
        </>
      )}
    </div>
  );
}
