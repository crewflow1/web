"use client";

import { DEMO_STATUS_LABELS, type DemoLifecycleStatus } from "@/lib/hq/demo-lifecycle";

/**
 * Demo card displayed inside a kanban column.
 *
 * Wraps the row data + an "Open" button that lifts state to the
 * parent (parent owns the side-panel state). The whole card is the
 * draggable handle, so the Open button uses stopPropagation to avoid
 * triggering a drag when clicked.
 */

export type DemoRow = {
  id: string;
  name: string;
  company: string;
  email: string;
  phone: string | null;
  status: string;
  employees: string | null;
  turnover_range: string | null;
  current_systems: string | null;
  preferred_demo_time: string | null;
  notes: string | null;
  source: string | null;
  created_at: string;
};

export function DemoCard({
  demo,
  status,
  active,
  onOpen,
}: {
  demo: DemoRow;
  status: DemoLifecycleStatus;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <article
      className={`group rounded-xl border px-3 py-2 transition ${
        active
          ? "border-indigo-400/40 bg-slate-900 ring-1 ring-inset ring-indigo-400/40"
          : "border-slate-800 bg-slate-900/60 hover:border-slate-700 hover:bg-slate-900"
      }`}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-white">
            {demo.company}
          </p>
          <p className="truncate text-[11px] text-slate-500">{demo.name}</p>
        </div>
        <button
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          className="shrink-0 rounded-md border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[10px] font-medium text-slate-300 transition hover:bg-slate-800"
          aria-label={`Open ${demo.company}`}
        >
          Open
        </button>
      </header>

      <dl className="mt-1.5 space-y-0.5 text-[11px] text-slate-300">
        <div className="flex justify-between gap-2">
          <dt className="shrink-0 text-slate-500">Status</dt>
          <dd className="truncate text-right">{DEMO_STATUS_LABELS[status]}</dd>
        </div>
        {demo.employees ? (
          <div className="flex justify-between gap-2">
            <dt className="shrink-0 text-slate-500">Staff</dt>
            <dd className="truncate text-right">{demo.employees}</dd>
          </div>
        ) : null}
        {demo.preferred_demo_time ? (
          <div className="flex justify-between gap-2">
            <dt className="shrink-0 text-slate-500">Time</dt>
            <dd className="truncate text-right">{demo.preferred_demo_time}</dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-2">
          <dt className="shrink-0 text-slate-500">Created</dt>
          <dd className="truncate text-right">
            {demo.created_at.slice(0, 10)}
          </dd>
        </div>
      </dl>
    </article>
  );
}
