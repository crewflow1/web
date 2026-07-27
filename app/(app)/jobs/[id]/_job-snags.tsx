import Link from "next/link";
import { formatDiaryDate } from "@/lib/site-diary/schema";
import {
  snagPriorityLabel,
  snagStatusLabel,
  type JobSnagSummary,
} from "@/lib/site-ops/job-panels";
import { JOB_SNAGS_PANEL_LIMIT, loadJobSnagsPanel } from "@/server/services/job-site-hub";

/**
 * Open snags on the job.
 *
 * The snagging vertical (app/(app)/snags) owns the lifecycle and every action;
 * this panel is a READ-ONLY window onto the job's defects with the counts a site
 * manager needs before walking the site, linking through for anything else. It
 * re-uses lib/snags/schema's status/priority vocabulary and its terminal-status
 * rule (via lib/site-ops/job-panels) rather than restating either.
 *
 * Best-effort: the service degrades a failed read to an empty summary.
 */

const STATUS_STYLES: Record<string, string> = {
  open: "bg-rose-100 text-rose-800",
  in_progress: "bg-amber-100 text-amber-800",
  fixed: "bg-blue-100 text-blue-800",
  verified: "bg-emerald-100 text-emerald-800",
  wont_fix: "bg-slate-100 text-slate-600",
};

const PRIORITY_STYLES: Record<string, string> = {
  high: "bg-red-100 text-red-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-slate-100 text-slate-700",
};

/** Priority counts, worded — never a bare coloured dot. */
function PriorityCounts({ summary }: { summary: JobSnagSummary }) {
  const shown = summary.byPriority.filter((p) => p.count > 0);
  if (shown.length === 0) return null;
  return (
    <ul className="mt-3 flex flex-wrap gap-2">
      {shown.map((p) => (
        <li
          key={p.priority}
          className={`rounded-full px-2.5 py-1 text-xs font-medium ${PRIORITY_STYLES[p.priority] ?? "bg-slate-100 text-slate-700"}`}
        >
          {p.count} {p.label.toLowerCase()} priority
        </li>
      ))}
      {summary.overdue > 0 ? (
        <li className="rounded-full border border-red-300 bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-800">
          {summary.overdue} past due date
        </li>
      ) : null}
    </ul>
  );
}

export async function JobSnagsSection({
  jobId,
  orgId,
  todayIso,
}: {
  jobId: string;
  orgId: string;
  todayIso: string;
}) {
  const summary = await loadJobSnagsPanel(orgId, jobId, todayIso);
  const listed = summary.openSnags.slice(0, JOB_SNAGS_PANEL_LIMIT);

  return (
    <section
      aria-labelledby="job-snags-heading"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="job-snags-heading" className="text-base font-semibold text-slate-900">
          Snags
        </h2>
        <p className="text-xs text-slate-500">
          {summary.total === 0
            ? "None raised"
            : `${summary.open} open of ${summary.total} raised`}
        </p>
      </div>

      <PriorityCounts summary={summary} />

      {summary.total === 0 ? (
        <p className="mt-3 text-sm text-slate-600">
          No defects logged against this job. Snags raised here feed the job&rsquo;s
          site timeline and its progress reports.
        </p>
      ) : listed.length === 0 ? (
        <p className="mt-3 text-sm text-emerald-800">
          Every snag on this job is closed out.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {listed.map((snag) => {
            const overdue = !!snag.due_date && !!todayIso && snag.due_date < todayIso;
            return (
              <li key={snag.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2.5">
                {/*
                  On a phone the title takes the whole line and the badges wrap
                  underneath it; from `sm` up they share one row. Without the
                  `basis-full` the title is squeezed into a 3-line column by the
                  pills next to it.
                */}
                <span className="min-w-0 basis-full sm:flex-1 sm:basis-0">
                  <Link
                    href={`/snags/${snag.id}`}
                    className="break-words font-medium text-slate-900 hover:underline"
                  >
                    {snag.title}
                  </Link>
                  {snag.location ? (
                    <span className="block break-words text-xs text-slate-500">
                      {snag.location}
                    </span>
                  ) : null}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${PRIORITY_STYLES[snag.priority] ?? "bg-slate-100 text-slate-700"}`}
                >
                  {snagPriorityLabel(snag.priority)}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[snag.status] ?? "bg-slate-100 text-slate-600"}`}
                >
                  {snagStatusLabel(snag.status)}
                </span>
                {snag.due_date ? (
                  <span
                    className={`text-xs ${overdue ? "font-semibold text-red-700" : "text-slate-500"}`}
                  >
                    {overdue ? "Overdue " : "Due "}
                    <time dateTime={snag.due_date}>{formatDiaryDate(snag.due_date)}</time>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          href={`/snags/new?job=${jobId}`}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
        >
          Log a snag
        </Link>
        <Link
          href="/snags"
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          {summary.open > listed.length
            ? `All ${summary.open} open snags`
            : "Open snag list"}
        </Link>
      </div>
    </section>
  );
}
