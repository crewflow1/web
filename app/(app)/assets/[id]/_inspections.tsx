import {
  INSPECTION_KIND_LABELS,
  INSPECTION_KINDS,
  INSPECTION_OUTCOME_LABELS,
  INSPECTION_OUTCOMES,
  INSPECTION_STATUS_LABELS,
  isSafetyBlocking,
  type InspectionKind,
  type InspectionOutcome,
  type InspectionStatus,
} from "@/lib/assets/inspection";
import { archiveInspection, createInspection, issueInspection } from "../inspection-actions";

export type InspectionRow = {
  id: string;
  title: string;
  kind: InspectionKind | null;
  safety_critical: boolean;
  status: InspectionStatus;
  outcome: InspectionOutcome | null;
  inspected_at: string | null;
  created_at: string;
};

const OUTCOME_STYLES: Record<InspectionOutcome, string> = {
  pass: "bg-emerald-100 text-emerald-800",
  pass_with_defects: "bg-amber-100 text-amber-800",
  fail: "bg-red-100 text-red-800",
};
const STATUS_STYLES: Record<InspectionStatus, string> = {
  draft: "bg-slate-100 text-slate-600",
  issued: "bg-blue-100 text-blue-700",
  superseded: "bg-slate-100 text-slate-500",
  archived: "bg-slate-100 text-slate-400",
};

/**
 * Asset inspections (M4a). Lists the asset's inspections, records new drafts,
 * and issues/archives them. A CURRENT issued safety-critical FAIL raises a
 * blocking banner (the same condition the M4b DB guard enforces on custody).
 */
export function InspectionsSection({ assetId, inspections }: { assetId: string; inspections: InspectionRow[] }) {
  const blocking = inspections.some((i) => isSafetyBlocking(i));

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">Inspections</h2>
        <span className="text-xs text-slate-500">{inspections.length} recorded</span>
      </div>

      {blocking ? (
        <div role="alert" className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          <strong>Failed safety inspection.</strong> This asset has a current safety-critical
          failure. Record a passing re-inspection before it is issued again.
        </div>
      ) : null}

      {inspections.length > 0 ? (
        <ul className="mt-4 divide-y divide-slate-100">
          {inspections.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-sm">
              <span className="font-medium text-slate-900">{i.title}</span>
              {i.kind ? <span className="text-xs text-slate-500">{INSPECTION_KIND_LABELS[i.kind]}</span> : null}
              {i.safety_critical ? (
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">Safety-critical</span>
              ) : null}
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[i.status]}`}>
                {INSPECTION_STATUS_LABELS[i.status]}
              </span>
              {i.outcome ? (
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${OUTCOME_STYLES[i.outcome]}`}>
                  {INSPECTION_OUTCOME_LABELS[i.outcome]}
                </span>
              ) : null}
              <span className="ml-auto text-xs text-slate-400">
                {(i.inspected_at ?? i.created_at).slice(0, 10)}
              </span>

              {i.status === "draft" ? (
                <div className="flex w-full flex-wrap items-end gap-2 pt-2">
                  <form action={issueInspection} className="flex items-end gap-2">
                    <input type="hidden" name="inspection_id" value={i.id} />
                    <label className="text-xs text-slate-600">
                      Outcome
                      <select
                        name="outcome"
                        required
                        defaultValue=""
                        className="ml-2 rounded-md border border-slate-300 px-2 py-1 text-xs"
                      >
                        <option value="" disabled>
                          Select…
                        </option>
                        {INSPECTION_OUTCOMES.map((o) => (
                          <option key={o} value={o}>
                            {INSPECTION_OUTCOME_LABELS[o]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button type="submit" className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800">
                      Issue
                    </button>
                  </form>
                  <form action={archiveInspection}>
                    <input type="hidden" name="inspection_id" value={i.id} />
                    <input type="hidden" name="asset_id" value={assetId} />
                    <button type="submit" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">
                      Discard
                    </button>
                  </form>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-slate-500">No inspections recorded yet.</p>
      )}

      {/* Record a new draft inspection. */}
      <form action={createInspection} className="mt-5 grid grid-cols-1 gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2">
        <input type="hidden" name="asset_id" value={assetId} />
        <label className="text-xs font-medium text-slate-600 sm:col-span-2">
          Inspection
          <input
            name="title"
            required
            maxLength={200}
            placeholder="e.g. LOLER thorough examination"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
          />
        </label>
        <label className="text-xs font-medium text-slate-600">
          Type
          <select name="kind" defaultValue="" className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900">
            <option value="">—</option>
            {INSPECTION_KINDS.map((k) => (
              <option key={k} value={k}>
                {INSPECTION_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 pt-6 text-xs font-medium text-slate-600">
          <input type="checkbox" name="safety_critical" value="on" className="h-4 w-4 rounded border-slate-300" />
          Safety-critical (a fail blocks the asset from being issued)
        </label>
        <label className="text-xs font-medium text-slate-600 sm:col-span-2">
          Notes
          <textarea
            name="notes"
            rows={2}
            maxLength={2000}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
          />
        </label>
        <div className="sm:col-span-2">
          <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
            Record inspection
          </button>
        </div>
      </form>
    </section>
  );
}
