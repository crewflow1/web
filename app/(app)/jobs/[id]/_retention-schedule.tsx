"use client";

import { useState } from "react";
import { formatGbp } from "@/lib/money";
import { setRetentionSchedule } from "../retention-actions";
import type { RetentionSchedule, MoietyStatus } from "@/lib/retentions/schedule";

/**
 * Retention release schedule (Programme C extension) — the forecast of WHEN held
 * retention is due back, plus an admin form to capture the terms that drive it.
 *
 * Presentational: the schedule is computed server-side (`computeRetentionSchedule`)
 * and passed in. Staff-internal — never rendered on the customer portal.
 */

const STATUS_STYLE: Record<MoietyStatus, string> = {
  released: "bg-emerald-100 text-emerald-700",
  due: "bg-amber-100 text-amber-700",
  upcoming: "bg-slate-100 text-slate-600",
};

function statusLabel(status: MoietyStatus, dueFrom: boolean, dueDate: string | null): string {
  if (status === "released") return "Released";
  if (status === "upcoming") return dueDate ? `Due ${dueFrom ? "from " : ""}${dueDate}` : "Awaiting date";
  // due
  return dueFrom ? `Due for release${dueDate ? ` from ${dueDate}` : ""}` : "Due now";
}

export function RetentionScheduleSection({
  jobId,
  schedule,
  isAdmin,
  current,
}: {
  jobId: string;
  schedule: RetentionSchedule;
  isAdmin: boolean;
  current: { practicalCompletionDate: string | null; defectsLiabilityMonths: number; firstReleasePct: number };
}) {
  const [editing, setEditing] = useState(false);
  if (!schedule.active) return null;

  return (
    <div className="mt-4 border-t border-slate-100 pt-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Release schedule</h3>
        {isAdmin ? (
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="text-xs font-medium text-slate-600 hover:text-slate-900"
          >
            {editing ? "Cancel" : current.practicalCompletionDate ? "Edit dates" : "Set completion date"}
          </button>
        ) : null}
      </div>

      {schedule.dueNow > 0 ? (
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <strong>{formatGbp(schedule.dueNow)}</strong> retention due for release — chase it back.
        </p>
      ) : null}

      {schedule.awaitingPcDate ? (
        <p className="mt-2 text-xs text-slate-500">
          {formatGbp(schedule.held)} held. Add a Practical Completion date to forecast when it&apos;s due back.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {schedule.moieties.map((m) => (
            <li key={m.key} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-slate-600">{m.label}</span>
              <span className="flex items-center gap-2">
                <span className="font-medium text-slate-900 tabular-nums">{formatGbp(m.amount)}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[m.status]}`}>
                  {statusLabel(m.status, m.dueFrom, m.dueDate)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {isAdmin && editing ? (
        <form
          action={setRetentionSchedule.bind(null, jobId)}
          className="mt-3 grid gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 sm:grid-cols-3"
        >
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-slate-700">Practical completion</span>
            <input
              type="date"
              name="practical_completion_date"
              defaultValue={current.practicalCompletionDate ?? ""}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-900 focus:outline-none"
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-slate-700">Defects period (months)</span>
            <input
              type="number"
              name="defects_liability_months"
              min={0}
              max={120}
              step={1}
              defaultValue={current.defectsLiabilityMonths}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-900 focus:outline-none"
            />
          </label>
          <label className="block text-xs">
            <span className="mb-1 block font-medium text-slate-700">First release (%)</span>
            <input
              type="number"
              name="retention_first_release_pct"
              min={0}
              max={100}
              step={5}
              defaultValue={current.firstReleasePct}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-900 focus:outline-none"
            />
          </label>
          <div className="sm:col-span-3">
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
            >
              Save schedule
            </button>
            <span className="ml-2 text-[11px] text-slate-400">
              JCT default: 50% at completion, the rest at end of the defects period.
            </span>
          </div>
        </form>
      ) : null}
    </div>
  );
}
