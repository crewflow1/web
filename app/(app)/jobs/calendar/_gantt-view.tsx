import Link from "next/link";
import { formatDateShortUK } from "@/lib/time/format";
import {
  buildGanttWindow,
  resolveJobSpan,
  layoutGantt,
  groupResourceLanes,
  type GanttBar,
} from "@/lib/jobs/span";
import type { JobSpanRow } from "@/lib/jobs/schedule-spans";

/**
 * Gantt + resource-swimlane presentation over the multi-day job spans
 * (20261132000003). Pure layout comes from lib/jobs/span.ts; this component only
 * renders. Read-only (a bar links to the job); the drag-drop reschedule stays on
 * the week view.
 *
 *   mode="gantt"    → every job as a bar on one shared timeline.
 *   mode="resource" → bars grouped into a lane per staff member (+ Unassigned).
 */

const STATUS_BAR: Record<string, string> = {
  new: "bg-blue-500",
  "in-progress": "bg-amber-500",
  completed: "bg-green-500",
  blocked: "bg-red-500",
};

function barLabel(row: JobSpanRow): string {
  return row.customer?.name ?? "Job";
}

function BarRow({
  bar,
  totalDays,
}: {
  bar: GanttBar<JobSpanRow>;
  totalDays: number;
}) {
  const row = bar.item;
  const color = STATUS_BAR[row.status] ?? "bg-slate-500";
  const leftPct = (bar.offsetDays / totalDays) * 100;
  const widthPct = (bar.spanDays / totalDays) * 100;
  return (
    <div className="relative h-8">
      <div className="absolute inset-0 rounded bg-slate-50" />
      <Link
        href={`/jobs/${row.id}`}
        style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
        className={`absolute top-0.5 flex h-7 items-center gap-1 overflow-hidden rounded px-2 text-[11px] font-medium text-white ${color} ${
          bar.clippedStart ? "rounded-l-none" : ""
        } ${bar.clippedEnd ? "rounded-r-none" : ""}`}
        title={`${barLabel(row)} · ${formatDateShortUK(bar.span.start)}${
          bar.span.multiDay ? ` → ${formatDateShortUK(bar.span.end)}` : ""
        }`}
      >
        {bar.clippedStart ? <span aria-hidden>‹</span> : null}
        <span className="truncate">{barLabel(row)}</span>
        {bar.clippedEnd ? <span aria-hidden>›</span> : null}
      </Link>
    </div>
  );
}

export function GanttView({
  rows,
  staff,
  range,
  mode,
}: {
  rows: JobSpanRow[];
  staff: { id: string; name: string }[];
  range: { from: string; to: string };
  mode: "gantt" | "resource";
}) {
  const window = buildGanttWindow(range.from, range.to);
  const bars = layoutGantt(
    rows,
    window,
    (r) => resolveJobSpan(r.scheduled_date, r.scheduled_end_date),
    (r) => r.id,
  );

  const scale = (
    <div className="mb-2 flex justify-between border-b border-slate-200 pb-1 text-[11px] text-slate-500">
      <span>{formatDateShortUK(range.from)}</span>
      <span>{formatDateShortUK(range.to)}</span>
    </div>
  );

  if (bars.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-500 shadow-sm">
        No scheduled jobs in this window.
      </div>
    );
  }

  if (mode === "resource") {
    const lanes = groupResourceLanes(bars, staff, (r) => r.assigned_to).filter(
      (lane) => lane.bars.length > 0,
    );
    return (
      <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        {scale}
        <div className="space-y-4">
          {lanes.map((lane) => (
            <div key={lane.key || "unassigned"}>
              <p className="mb-1 text-xs font-semibold text-slate-700">
                {lane.label}{" "}
                <span className="font-normal text-slate-400">
                  ({lane.bars.length})
                </span>
              </p>
              <div className="space-y-1">
                {lane.bars.map((bar) => (
                  <BarRow key={bar.item.id} bar={bar} totalDays={window.totalDays} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      {scale}
      <div className="space-y-1">
        {bars.map((bar) => (
          <BarRow key={bar.item.id} bar={bar} totalDays={window.totalDays} />
        ))}
      </div>
    </div>
  );
}
