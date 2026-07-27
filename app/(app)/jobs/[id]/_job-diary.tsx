import Link from "next/link";
import { formatDiaryDate } from "@/lib/site-diary/schema";
import { loadJobDiaryPanel } from "@/server/services/job-site-hub";

/**
 * Site diary on the job.
 *
 * The diary vertical (app/(app)/diary) already owns creating, editing and
 * listing entries; this panel only SURFACES the job's slice of it where a site
 * manager actually stands — on the job — and links through. It re-uses the
 * vertical's own date formatter so a date never renders two ways in one product.
 *
 * Best-effort: the service swallows read failures to an empty summary, so this
 * panel degrades to its empty state and can never break the job page.
 */
export async function JobDiarySection({
  jobId,
  orgId,
}: {
  jobId: string;
  orgId: string;
}) {
  const summary = await loadJobDiaryPanel(orgId, jobId);

  return (
    <section
      aria-labelledby="job-diary-heading"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="job-diary-heading" className="text-base font-semibold text-slate-900">
          Site diary
        </h2>
        <p className="text-xs text-slate-500">
          {summary.total === 0
            ? "No entries yet"
            : `${summary.total} ${summary.total === 1 ? "entry" : "entries"}` +
              (summary.withDelays > 0
                ? ` · ${summary.withDelays} recording a delay`
                : "")}
        </p>
      </div>

      {summary.recent.length === 0 ? (
        <p className="mt-3 text-sm text-slate-600">
          Nothing logged for this job yet. A daily entry is what proves what
          happened on site when a delay is later disputed.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {summary.recent.map((entry) => (
            <li key={entry.id} className="py-2.5">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <Link
                  href={`/diary/${entry.id}`}
                  className="font-medium text-slate-900 hover:underline"
                >
                  <time dateTime={entry.entry_date}>
                    {formatDiaryDate(entry.entry_date)}
                  </time>
                </Link>
                {typeof entry.labour_count === "number" ? (
                  <span className="text-xs text-slate-500">
                    {entry.labour_count} on site
                  </span>
                ) : null}
                {entry.weather ? (
                  <span className="min-w-0 break-words text-xs text-slate-500">
                    {entry.weather}
                  </span>
                ) : null}
                {entry.delays && entry.delays.trim() !== "" ? (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                    Delay logged
                  </span>
                ) : null}
              </div>
              {entry.work_summary ? (
                <p className="mt-0.5 line-clamp-2 break-words text-xs text-slate-600">
                  {entry.work_summary}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <Link
          href={`/diary/new?job=${jobId}`}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
        >
          Log today&rsquo;s entry
        </Link>
        {summary.total > summary.recent.length ? (
          <Link
            href="/diary"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            All {summary.total} diary entries
          </Link>
        ) : (
          <Link
            href="/diary"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Open site diary
          </Link>
        )}
      </div>
    </section>
  );
}
