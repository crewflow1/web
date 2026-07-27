import Link from "next/link";
import { formatDiaryDate } from "@/lib/site-diary/schema";
import { formatTimeUK } from "@/lib/time/format";
import {
  groupSiteTimelineByDay,
  SITE_EVENT_KIND_META,
  type SiteTimelineEvent,
} from "@/lib/site-ops/timeline";
import { loadJobSiteTimeline } from "@/server/services/job-site-hub";

/**
 * Site timeline — one chronological feed of everything that happened on this
 * job: diary entries, snags raised and closed, toolbox talks, RAMS and permits,
 * inspections of the plant that has been here, and the photos and documents
 * uploaded against any of it.
 *
 * READ-ONLY and purely composed: every row already exists in a vertical that
 * owns it, and each row links back there for any action. Ordering and labelling
 * are decided by the pure composer (lib/site-ops/timeline.ts); this component
 * only renders.
 *
 * Renders nothing when the job has no activity — an empty feed is noise on a
 * page that already carries eight other panels.
 */

function EventRow({ event }: { event: SiteTimelineEvent }) {
  const meta = SITE_EVENT_KIND_META[event.kind];
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-2.5">
      {/* The kind is stated as a WORD; the tint only reinforces it. */}
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${meta.tone}`}>
        {meta.label}
      </span>
      {event.dateOnly ? null : (
        <span className="shrink-0 font-mono text-xs tabular-nums text-slate-500">
          <time dateTime={event.at}>{formatTimeUK(event.at)}</time>
        </span>
      )}
      <span className="min-w-0 flex-1 basis-full break-words text-slate-800 sm:basis-0">
        {event.href ? (
          <Link href={event.href} className="font-medium text-slate-900 hover:underline">
            {event.title}
          </Link>
        ) : (
          <span className="font-medium text-slate-900">{event.title}</span>
        )}
        {event.detail ? (
          <span className="block break-words text-xs text-slate-600">{event.detail}</span>
        ) : null}
      </span>
      {event.status ? (
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">
          {event.status}
        </span>
      ) : null}
    </li>
  );
}

export async function SiteTimelineSection({
  jobId,
  orgId,
}: {
  jobId: string;
  orgId: string;
}) {
  const { events, total } = await loadJobSiteTimeline(orgId, jobId);
  if (events.length === 0) return null;

  const days = groupSiteTimelineByDay(events);

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
        Diary, snags, safety, plant and uploads for this job, newest first.
      </p>

      <div className="mt-4 space-y-4">
        {days.map((group) => (
          <div key={group.day}>
            <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
              <time dateTime={group.day}>{formatDiaryDate(group.day)}</time>
            </h3>
            <ul className="mt-1 divide-y divide-slate-100 text-sm">
              {group.events.map((event) => (
                <EventRow key={event.key} event={event} />
              ))}
            </ul>
          </div>
        ))}
      </div>

      {total > events.length ? (
        <p className="mt-4 text-xs text-slate-500">
          Older activity stays available in each area —{" "}
          <Link href="/diary" className="font-medium text-slate-700 hover:underline">
            site diary
          </Link>
          ,{" "}
          <Link href="/snags" className="font-medium text-slate-700 hover:underline">
            snags
          </Link>{" "}
          and{" "}
          <Link href="/toolbox" className="font-medium text-slate-700 hover:underline">
            toolbox talks
          </Link>
          .
        </p>
      ) : null}
    </section>
  );
}
