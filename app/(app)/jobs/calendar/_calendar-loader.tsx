"use client";

import dynamic from "next/dynamic";
import type { ComponentProps } from "react";
import type { CalendarClient as CalendarClientImpl } from "./_calendar";

/**
 * Client loader for the week-view calendar.
 *
 * `@dnd-kit/core` (~10–13 KB gzip) is only needed for the drag/drop week
 * grid in `_calendar.tsx`. Month + Gantt visitors never render this
 * component, so importing `CalendarClient` statically shipped dnd-kit into
 * the first-load JS of every `/jobs/calendar` visit regardless of view.
 *
 * Here we lazy-load it with `ssr: false` behind a client boundary (a Server
 * Component may not pass `ssr: false` to `next/dynamic`). `/jobs/calendar`
 * is an authenticated app route, so client-only rendering of the drag
 * surface has no SEO cost. The `loading` skeleton is sized to the real
 * week-grid layout (header + filter bar + 7 × `min-h-[120px]` day columns)
 * so first paint does not shift once the chunk hydrates.
 *
 * Behaviour, props and types are identical to the underlying component —
 * only the import mechanism changes.
 */

type CalendarClientProps = ComponentProps<typeof CalendarClientImpl>;

const LazyCalendarClient = dynamic(
  () => import("./_calendar").then((m) => m.CalendarClient),
  {
    ssr: false,
    loading: () => <WeekGridSkeleton />,
  },
);

export function CalendarClient(props: CalendarClientProps) {
  return <LazyCalendarClient {...props} />;
}

function WeekGridSkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      {/* header row: title + nav buttons */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-2">
          <div className="h-7 w-28 animate-pulse rounded bg-slate-200" />
          <div className="h-4 w-56 animate-pulse rounded bg-slate-100" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-8 w-24 animate-pulse rounded-md bg-slate-100" />
          <div className="h-8 w-16 animate-pulse rounded-md bg-slate-200" />
          <div className="h-8 w-16 animate-pulse rounded-md bg-slate-100" />
        </div>
      </div>

      {/* filter bar */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
        <div className="h-[52px] w-32 animate-pulse rounded bg-slate-100" />
        <div className="h-[52px] w-32 animate-pulse rounded bg-slate-100" />
        <div className="h-8 w-16 animate-pulse rounded-md bg-slate-200" />
      </div>

      {/* week grid: 7 day columns on md+, stacked on mobile */}
      <ol className="grid grid-cols-1 gap-3 md:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
          <li
            key={i}
            className="flex min-h-[120px] flex-col rounded-xl border border-slate-200 bg-slate-50/60"
          >
            <div className="border-b border-slate-200 px-3 py-2">
              <div className="h-4 w-20 animate-pulse rounded bg-slate-200" />
            </div>
            <div className="flex-1 space-y-2 p-2">
              <div className="h-16 animate-pulse rounded-md bg-white" />
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
