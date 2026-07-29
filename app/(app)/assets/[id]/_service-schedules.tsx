import {
  SCHEDULE_CADENCES,
  SCHEDULE_CADENCE_LABELS,
  intervalLabel,
  isInspectionOverdue,
} from "@/lib/assets/inspection-schedule";
import { MAINTENANCE_TYPE_LABELS, type MaintenanceType } from "@/lib/assets/maintenance";
import {
  createServiceSchedule,
  deleteServiceSchedule,
  toggleServiceSchedule,
} from "../service-schedule-actions";

export type ServiceScheduleRow = {
  id: string;
  maintenance_type: MaintenanceType;
  title: string | null;
  interval_days: number | null;
  interval_months: number | null;
  next_due: string;
  lead_time_days: number;
  active: boolean;
};

const SERVICE_TYPES = ["preventive", "service", "calibration"] as const;

/**
 * Service schedules (M5b) — the maintenance twin of the inspection schedules
 * section. Standing rules generating maintenance cases; admin-only writes.
 */
export function ServiceSchedulesSection({
  assetId,
  schedules,
  isAdmin,
  today,
}: {
  assetId: string;
  schedules: ServiceScheduleRow[];
  isAdmin: boolean;
  today: string;
}) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">Service schedules</h2>
        <span className="text-xs text-slate-500">{schedules.length} standing</span>
      </div>
      <p className="mt-0.5 text-xs text-slate-500">
        Service cases are generated automatically ahead of their due date (lead time
        for booking parts and fitters).
      </p>

      {schedules.length > 0 ? (
        <ul className="mt-3 divide-y divide-slate-100 text-sm">
          {schedules.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
              <span className="font-medium text-slate-900">
                {s.title?.trim() || MAINTENANCE_TYPE_LABELS[s.maintenance_type]}
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
              {isAdmin ? (
                <span className="ml-auto flex items-center gap-1">
                  <form action={toggleServiceSchedule}>
                    <input type="hidden" name="asset_id" value={assetId} />
                    <input type="hidden" name="schedule_id" value={s.id} />
                    <input type="hidden" name="next_active" value={s.active ? "false" : "true"} />
                    <button type="submit" className="rounded-md border border-slate-300 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50">
                      {s.active ? "Pause" : "Resume"}
                    </button>
                  </form>
                  <form action={deleteServiceSchedule}>
                    <input type="hidden" name="asset_id" value={assetId} />
                    <input type="hidden" name="schedule_id" value={s.id} />
                    <button type="submit" className="rounded-md border border-red-300 px-2 py-1 text-[11px] text-red-700 hover:bg-red-50">
                      Remove
                    </button>
                  </form>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-slate-500">No service schedules yet.</p>
      )}

      {isAdmin ? (
        <details className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
          <summary className="cursor-pointer text-xs font-semibold text-slate-700">+ Add service schedule</summary>
          <form action={createServiceSchedule} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input type="hidden" name="asset_id" value={assetId} />
            <label className="text-xs font-medium text-slate-600">
              Type
              <select name="maintenance_type" defaultValue="service" className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-sm">
                {SERVICE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {MAINTENANCE_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-600">
              Name (optional)
              <input name="title" maxLength={160} placeholder="e.g. 500-hour service" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Cadence
              <select name="cadence" defaultValue="six_monthly" className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-sm">
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
              <input name="lead_time_days" type="number" min={0} max={365} defaultValue={14} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
            </label>
            <div className="sm:col-span-2">
              <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
                Add schedule
              </button>
            </div>
          </form>
        </details>
      ) : null}
    </section>
  );
}
