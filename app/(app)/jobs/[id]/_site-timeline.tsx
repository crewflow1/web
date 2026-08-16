import Link from "next/link";
import { loadJobSiteTimeline } from "@/server/services/job-site-hub";
import { TimelineDayGroups } from "./_timeline-feed";

/**
 * Site timeline — one chronological feed of everything that happened on this
 * job: diary entries, delays, snags raised and closed, toolbox talks, RAMS and
 * permits, inspections of the plant that has been here, site reports, drawing
 * revisions, and the photos and documents uploaded against any of it.
 *
 * READ-ONLY and purely composed: every row already exists in a vertical that
 * owns it, and each row links back there for any action. Ordering and labelling
 * are decided by the pure composer (lib/site-ops/timeline.ts); the shared
 * `_timeline-feed` renders it — the same feed the full `/jobs/[id]/timeline`
 * route uses.
 *
 * Renders nothing when the job has no activity — an empty feed is noise on a
 * page that already carries eight other panels. (The full route, by contrast,
 * shows an explicit empty state.)
 */
export async function SiteTimelineSection({
  jobId,
  orgId,
}: {
  jobId: string;
  orgId: string;
}) {
  const { events, total } = await loadJobSiteTimeline(orgId, jobId);
  if (events.length === 0) return null;

  return (
    <section
      aria-labelledby="job-timeline-heading"
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="job-timeline-heading" className="text-base font-semibold text-slate-900">
          Site timeline
        </h2>
        <p className="text-xs text-slate-500">
          {total > events.length
            ? `Latest ${events.length} of ${total} events`
            : `${total} ${total === 1 ? "event" : "events"}`}
        </p>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Diary, delays, snags, safety, reports, drawings and uploads for this job,
        newest first.
      </p>

      <div className="mt-4">
        <TimelineDayGroups events={events} />
      </div>

      <p className="mt-4 text-xs text-slate-500">
        <Link
          href={`/jobs/${jobId}/timeline`}
          className="font-medium text-slate-700 hover:underline"
        >
          {total > events.length ? `View all ${total} events →` : "View full timeline →"}
        </Link>
      </p>
    </section>
  );
}
