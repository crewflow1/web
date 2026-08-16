import Link from "next/link";
import { formatDiaryDate } from "@/lib/site-diary/schema";
import { formatTimeUK } from "@/lib/time/format";
import {
  groupSiteTimelineByDay,
  SITE_EVENT_KIND_META,
  type SiteTimelineEvent,
} from "@/lib/site-ops/timeline";

/**
 * Site timeline — the shared presentation of a composed feed.
 *
 * Pure rendering: the ordering + labelling is already decided by the composer
 * (lib/site-ops/timeline.ts). Both the compact job-page panel
 * (`_site-timeline.tsx`) and the full `/jobs/[id]/timeline` route render through
 * these, so a change to how an event reads happens in ONE place.
 */

export function TimelineEventRow({ event }: { event: SiteTimelineEvent }) {
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

/** An already-ordered feed rendered as day-grouped rows (newest day first). */
export function TimelineDayGroups({ events }: { events: readonly SiteTimelineEvent[] }) {
  const days = groupSiteTimelineByDay(events);
  return (
    <div className="space-y-4">
      {days.map((group) => (
        <div key={group.day}>
          <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            <time dateTime={group.day}>{formatDiaryDate(group.day)}</time>
          </h3>
          <ul className="mt-1 divide-y divide-slate-100 text-sm">
            {group.events.map((event) => (
              <TimelineEventRow key={event.key} event={event} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
