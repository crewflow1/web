import {
  SCHEDULE_CADENCES,
  SCHEDULE_CADENCE_LABELS,
  intervalLabel,
  isInspectionOverdue,
} from "@/lib/assets/inspection-schedule";
import type { PublishedTemplate } from "./_inspections";
import {
  createInspectionSchedule,
  deleteInspectionSchedule,
  toggleInspectionSchedule,
} from "../schedule-actions";
import { StateForm } from "@/components/forms/StateForm";

export type ScheduleRow = {
  id: string;
  template_id: string;
  interval_days: number | null;
  interval_months: number | null;
  next_due: string;
  lead_time_days: number;
  active: boolean;
  required_for_assignment: boolean;
  asset_inspection_templates: { name: string; version: number } | null;
};

/**
 * Inspection schedules (M4b-2) — the standing rules that generate due work.
 * Admin-only writes (the actions + RLS enforce it; the form renders only for
 * admins). "Required before issue" is captured now and enforced at the custody
 * guard in M4d.
 */
export function SchedulesSection({
  assetId,
  schedules,
  templates,
  isAdmin,
  today,
}: {
  assetId: string;
  schedules: ScheduleRow[];
  templates: PublishedTemplate[];
  isAdmin: boolean;
  today: string;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">Inspection schedules</h2>
        <span className="text-xs text-slate-500">{schedules.length} standing</span>
      </div>
      <p className="mt-0.5 text-xs text-slate-500">
        Due inspections are generated automatically each morning from the template&apos;s
        current published version.
      </p>

      {schedules.length > 0 ? (
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {schedules.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
              <span className="font-medium text-slate-900">
                {s.asset_inspection_templates?.name ?? "Template"}
              </span>
              <span className="text-xs text-slate-500">
                {intervalLabel({ interval_days: s.interval_days, interval_months: s.interval_months })}
              </span>
              <span
                className={`text-xs ${
                  s.active && isInspectionOverdue(`${s.next_due}T00:00:00.000Z`, today)
                    ? "font-semibold text-red-700"
                    : "text-slate-500"
                }`}
              >
                next due {s.next_due}
              </span>
              {!s.active ? (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">Paused</span>
              ) : null}
              {s.required_for_assignment ? (
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                  Required before issue
                </span>
              ) : null}
              {isAdmin ? (
                <span className="ml-auto flex items-center gap-1">
                  <StateForm action={toggleInspectionSchedule}>
                    <input type="hidden" name="asset_id" value={assetId} />
                    <input type="hidden" name="schedule_id" value={s.id} />
                    <input type="hidden" name="next_active" value={s.active ? "false" : "true"} />
                    <button type="submit" className="rounded-md border border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50">
                      {s.active ? "Pause" : "Resume"}
                    </button>
                  </StateForm>
                  <StateForm action={deleteInspectionSchedule}>
                    <input type="hidden" name="asset_id" value={assetId} />
                    <input type="hidden" name="schedule_id" value={s.id} />
                    <button type="submit" className="rounded-md border border-red-300 px-2 py-1 text-[11px] text-red-700 hover:bg-red-50">
                      Remove
                    </button>
                  </StateForm>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-slate-500">No schedules yet.</p>
      )}

      {isAdmin && templates.length > 0 ? (
        <details className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
          <summary className="cursor-pointer text-xs font-semibold text-slate-700">+ Add schedule</summary>
          <StateForm action={createInspectionSchedule} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input type="hidden" name="asset_id" value={assetId} />
            <label className="text-xs font-medium text-slate-600">
              Template
              <select name="template_id" required defaultValue="" className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-sm">
                <option value="" disabled>
                  Choose…
                </option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} (v{t.version})
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-600">
              Cadence
              <select name="cadence" defaultValue="daily" className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-sm">
                {SCHEDULE_CADENCES.map((c) => (
                  <option key={c} value={c}>
                    {SCHEDULE_CADENCE_LABELS[c]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-600">
              Custom interval (days)
              <input name="custom_days" type="number" min={1} max={3660} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              First due
              <input name="next_due" type="date" required className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Generate days ahead
              <input name="lead_time_days" type="number" min={0} max={365} defaultValue={0} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <label className="flex items-center gap-2 pt-6 text-xs font-medium text-slate-600">
              <input type="checkbox" name="required_for_assignment" className="h-4 w-4 rounded border-slate-300" />
              Required before issue (enforced with overrides in a later release)
            </label>
            <div className="sm:col-span-2">
              <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
                Add schedule
              </button>
            </div>
          </StateForm>
        </details>
      ) : null}
    </section>
  );
}
