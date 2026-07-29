import {
  MAINTENANCE_PRIORITIES,
  MAINTENANCE_STATUSES,
  MAINTENANCE_STATUS_LABELS,
  MAINTENANCE_TYPES,
  MAINTENANCE_TYPE_LABELS,
  canTransitionCase,
  downtimeHours,
  isActiveCase,
  type MaintenanceStatus,
  type MaintenanceType,
} from "@/lib/assets/maintenance";
import { reportMaintenanceCase, transitionMaintenanceCase, upsertCaseCosts } from "../maintenance-actions";
import { StateForm } from "@/components/forms/StateForm";
import { startReinspection } from "../inspection-actions";

export type MaintenanceCaseRow = {
  id: string;
  case_type: MaintenanceType;
  priority: string;
  status: MaintenanceStatus;
  title: string;
  out_of_service: boolean;
  reinspection_required: boolean;
  work_performed: string | null;
  downtime_start: string | null;
  downtime_end: string | null;
  created_at: string;
  source_inspection_id: string | null;
};

const STATUS_STYLES: Partial<Record<MaintenanceStatus, string>> = {
  reported: "bg-amber-100 text-amber-800",
  in_progress: "bg-blue-100 text-blue-700",
  awaiting_parts: "bg-slate-100 text-slate-600",
  awaiting_supplier: "bg-slate-100 text-slate-600",
  ready_for_reinspection: "bg-purple-100 text-purple-700",
  ready_for_return_to_service: "bg-emerald-100 text-emerald-800",
  completed: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-slate-100 text-slate-400",
};

/**
 * Maintenance cases (M5a) — one shared repair flow. Transition choices are the
 * LEGAL next states from the unit-tested matrix (the DB guard is the hard
 * gate); costs are an admin-only satellite, invisible to members at the DB.
 */
export function MaintenanceSection({
  assetId,
  cases,
  isAdmin,
}: {
  assetId: string;
  cases: MaintenanceCaseRow[];
  isAdmin: boolean;
}) {
  const active = cases.filter((c) => isActiveCase(c.status));
  const closed = cases.filter((c) => !isActiveCase(c.status)).slice(0, 5);
  const outOfService = active.some((c) => c.out_of_service);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">Maintenance</h2>
        <span className="text-xs text-slate-500">{active.length} open</span>
      </div>

      {outOfService ? (
        <div role="alert" className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <strong>Out of service.</strong> An open maintenance case has this asset out of
          service — check with the repair owner before issuing it.
        </div>
      ) : null}

      {[...active, ...closed].map((c) => (
        <CaseRow key={c.id} assetId={assetId} c={c} isAdmin={isAdmin} />
      ))}
      {cases.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No maintenance recorded yet.</p>
      ) : null}

      <details className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
        <summary className="cursor-pointer text-xs font-semibold text-slate-700">+ Report fault / plan work</summary>
        <StateForm action={reportMaintenanceCase} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input type="hidden" name="asset_id" value={assetId} />
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">
            What&apos;s wrong / what&apos;s needed
            <input name="title" required maxLength={200} placeholder="e.g. Hydraulic hose burst on dipper" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="text-xs font-medium text-slate-600">
            Type
            <select name="case_type" defaultValue="breakdown" className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-sm">
              {MAINTENANCE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {MAINTENANCE_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">
            Priority
            <select name="priority" defaultValue="medium" className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-sm">
              {MAINTENANCE_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p[0]?.toUpperCase() + p.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">
            Details
            <textarea name="description" rows={2} maxLength={4000} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
          </label>
          <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
            <input type="checkbox" name="out_of_service" className="h-4 w-4 rounded border-slate-300" />
            Out of service (downtime starts now)
          </label>
          <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
            <input type="checkbox" name="reinspection_required" className="h-4 w-4 rounded border-slate-300" />
            Re-inspection required before return
          </label>
          <div className="sm:col-span-2">
            <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
              Report
            </button>
          </div>
        </StateForm>
      </details>
    </section>
  );
}

function CaseRow({ assetId, c, isAdmin }: { assetId: string; c: MaintenanceCaseRow; isAdmin: boolean }) {
  const ctx = {
    reinspectionRequired: c.reinspection_required,
    workEvidencePresent: !!c.work_performed?.trim(),
  };
  const nextStates = MAINTENANCE_STATUSES.filter(
    (to) => to !== c.status && canTransitionCase(c.status, to, { ...ctx, workEvidencePresent: true }),
  );
  const hours = downtimeHours(c.downtime_start, c.downtime_end);

  return (
    <div className="mt-3 rounded-md border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium text-slate-900">{c.title}</span>
        <span className="text-xs text-slate-500">{MAINTENANCE_TYPE_LABELS[c.case_type]}</span>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[c.status] ?? "bg-slate-100 text-slate-600"}`}>
          {MAINTENANCE_STATUS_LABELS[c.status]}
        </span>
        {c.out_of_service && isActiveCase(c.status) ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-800">Out of service</span>
        ) : null}
        {c.reinspection_required ? (
          <span className="rounded-full bg-purple-50 px-2 py-0.5 text-[11px] font-medium text-purple-700">Re-inspection required</span>
        ) : null}
        {hours != null ? <span className="text-[11px] text-slate-400">{hours}h down</span> : null}
        <span className="ml-auto text-xs text-slate-400">{c.created_at.slice(0, 10)}</span>
      </div>

      {c.status === "ready_for_reinspection" && c.source_inspection_id ? (
        <StateForm action={startReinspection} className="mt-2">
          <input type="hidden" name="inspection_id" value={c.source_inspection_id} />
          <button type="submit" className="rounded-md bg-purple-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-800">
            Start re-inspection
          </button>
        </StateForm>
      ) : null}
      {isActiveCase(c.status) && nextStates.length > 0 ? (
        <StateForm action={transitionMaintenanceCase} className="mt-2 flex flex-wrap items-end gap-2">
          <input type="hidden" name="case_id" value={c.id} />
          <label className="text-xs text-slate-600">
            Move to
            <select name="to" required defaultValue="" className="ml-2 rounded-md border border-slate-300 px-2 py-1.5 text-xs">
              <option value="" disabled>
                Choose…
              </option>
              {nextStates.map((s) => (
                <option key={s} value={s}>
                  {MAINTENANCE_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <input
            name="work_performed"
            defaultValue={c.work_performed ?? ""}
            placeholder="Work done (required to complete)"
            className="min-w-0 flex-1 rounded-md border border-slate-200 px-3 py-1.5 text-xs"
          />
          <input
            name="cancellation_reason"
            placeholder="Reason (required to cancel)"
            className="rounded-md border border-slate-200 px-3 py-1.5 text-xs"
          />
          <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800">
            Apply
          </button>
        </StateForm>
      ) : null}
      {c.status === "cancelled" ? (
        <StateForm action={transitionMaintenanceCase} className="mt-2">
          <input type="hidden" name="case_id" value={c.id} />
          <input type="hidden" name="to" value="reported" />
          <button type="submit" className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
            Reopen
          </button>
        </StateForm>
      ) : null}

      {isAdmin && isActiveCase(c.status) ? (
        <details className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-2">
          <summary className="cursor-pointer text-[11px] font-semibold text-slate-600">Costs (admin only)</summary>
          <StateForm action={upsertCaseCosts} className="mt-2 flex flex-wrap items-end gap-2">
            <input type="hidden" name="asset_id" value={assetId} />
            <input type="hidden" name="case_id" value={c.id} />
            {(["cost_parts", "cost_labour", "cost_external"] as const).map((f) => (
              <label key={f} className="text-[11px] font-medium text-slate-600">
                {f === "cost_parts" ? "Parts £" : f === "cost_labour" ? "Labour £" : "External £"}
                <input name={f} type="number" step="0.01" min={0} className="mt-1 w-24 rounded-md border border-slate-300 px-2 py-1 text-xs" />
              </label>
            ))}
            <input name="cost_notes" placeholder="Notes" className="min-w-0 flex-1 rounded-md border border-slate-200 px-2 py-1 text-xs" />
            <button type="submit" className="rounded-md border border-slate-300 px-3 py-1 text-[11px] font-medium text-slate-700 hover:bg-white">
              Save costs
            </button>
          </StateForm>
        </details>
      ) : null}
    </div>
  );
}
