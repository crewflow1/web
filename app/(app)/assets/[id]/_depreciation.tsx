import { StateForm } from "@/components/forms/StateForm";
import {
  DEPRECIATION_METHODS,
  DEPRECIATION_METHOD_LABELS,
  computeNbv,
  depreciationSchedule,
  type DepreciationMethod,
  type DepreciationPolicy,
} from "@/lib/assets/depreciation";
import { saveDepreciationSettings, clearDepreciationSettings } from "../depreciation-actions";

export type DepreciationSettingsRow = {
  method: DepreciationMethod;
  cost: number | string;
  salvage_value: number | string;
  start_date: string;
  useful_life_months: number | null;
  annual_rate_pct: number | string | null;
};

const GBP = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2 });
const money = (v: number) => GBP.format(v);

function toPolicy(row: DepreciationSettingsRow): DepreciationPolicy {
  return {
    method: row.method,
    cost: Number(row.cost),
    salvage_value: Number(row.salvage_value),
    start_date: row.start_date,
    useful_life_months: row.useful_life_months,
    annual_rate_pct: row.annual_rate_pct == null ? null : Number(row.annual_rate_pct),
  };
}

/**
 * Depreciation / net book value (P3W2). NBV and the schedule are COMPUTED here
 * from the saved policy — nothing is stored derived. Admin-only writes; every
 * member sees the current NBV. Defaults for the form come from the asset's
 * purchase price / date.
 */
export function DepreciationSection({
  assetId,
  settings,
  isAdmin,
  today,
  defaultCost,
  defaultStart,
}: {
  assetId: string;
  settings: DepreciationSettingsRow | null;
  isAdmin: boolean;
  today: string;
  defaultCost: number | string | null;
  defaultStart: string | null;
}) {
  const policy = settings ? toPolicy(settings) : null;
  const nbv = policy ? computeNbv(policy, today) : null;
  const schedule = policy ? depreciationSchedule(policy) : [];

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">Depreciation</h2>
        {policy ? (
          <span className="text-xs text-slate-500">{DEPRECIATION_METHOD_LABELS[policy.method]}</span>
        ) : null}
      </div>

      {policy && nbv ? (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Stat label="Net book value" value={money(nbv.nbv)} strong />
            <Stat label="Cost basis" value={money(policy.cost)} />
            <Stat label="Accumulated" value={money(nbv.accumulatedDepreciation)} />
            <Stat label="Salvage" value={money(policy.salvage_value)} />
          </dl>
          <p className="mt-2 text-xs text-slate-500">
            As of {today}. {nbv.fullyDepreciated ? "Fully depreciated to salvage." : `Computed on read from the policy below.`}
          </p>

          {schedule.length > 0 ? (
            <details className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3">
              <summary className="cursor-pointer text-xs font-semibold text-slate-700">
                Depreciation schedule ({schedule.length} {schedule[0]!.granularity === "month" ? "months" : "years"})
              </summary>
              <div className="mt-3 overflow-x-auto">
                <table className="min-w-full text-xs">
                  <thead className="text-left text-slate-500">
                    <tr>
                      <th className="py-1 pr-3">Period start</th>
                      <th className="py-1 pr-3">Opening</th>
                      <th className="py-1 pr-3">Depreciation</th>
                      <th className="py-1 pr-3">Accumulated</th>
                      <th className="py-1 pr-3">Closing</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-slate-700">
                    {schedule.map((p) => (
                      <tr key={p.index}>
                        <td className="py-1 pr-3">{p.periodStart}</td>
                        <td className="py-1 pr-3">{money(p.openingValue)}</td>
                        <td className="py-1 pr-3">{money(p.depreciation)}</td>
                        <td className="py-1 pr-3">{money(p.accumulatedDepreciation)}</td>
                        <td className="py-1 pr-3">{money(p.closingValue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ) : null}
        </>
      ) : (
        <p className="mt-3 text-sm text-slate-500">
          No depreciation policy set. {isAdmin ? "Add one to track net book value." : "An owner or admin can set one."}
        </p>
      )}

      {isAdmin ? (
        <details className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3" open={!policy}>
          <summary className="cursor-pointer text-xs font-semibold text-slate-700">
            {policy ? "Edit depreciation policy" : "+ Set depreciation policy"}
          </summary>
          <StateForm action={saveDepreciationSettings} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input type="hidden" name="asset_id" value={assetId} />
            <label className="text-xs font-medium text-slate-600">
              Method
              <select
                name="method"
                defaultValue={policy?.method ?? "straight_line"}
                className="mt-1 w-full rounded-md border border-slate-300 px-2 py-2 text-sm"
              >
                {DEPRECIATION_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {DEPRECIATION_METHOD_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs font-medium text-slate-600">
              Cost basis (£)
              <input
                name="cost"
                type="number"
                step="0.01"
                min={0}
                required
                defaultValue={policy ? String(policy.cost) : (defaultCost != null ? String(defaultCost) : "")}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Salvage value (£)
              <input
                name="salvage_value"
                type="number"
                step="0.01"
                min={0}
                defaultValue={policy ? String(policy.salvage_value) : "0"}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Start date
              <input
                name="start_date"
                type="date"
                required
                defaultValue={policy?.start_date ?? defaultStart ?? ""}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Useful life (months) — straight line
              <input
                name="useful_life_months"
                type="number"
                min={1}
                max={1200}
                defaultValue={policy?.useful_life_months != null ? String(policy.useful_life_months) : "60"}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="text-xs font-medium text-slate-600">
              Annual rate (%) — reducing balance
              <input
                name="annual_rate_pct"
                type="number"
                step="0.001"
                min={0}
                max={100}
                defaultValue={policy?.annual_rate_pct != null ? String(policy.annual_rate_pct) : "25"}
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
              />
            </label>
            <div className="sm:col-span-2 flex items-center gap-2">
              <button type="submit" className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
                {policy ? "Update policy" : "Save policy"}
              </button>
            </div>
          </StateForm>
          {policy ? (
            <StateForm action={clearDepreciationSettings} className="mt-2">
              <input type="hidden" name="asset_id" value={assetId} />
              <button type="submit" className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50">
                Remove depreciation policy
              </button>
            </StateForm>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`mt-0.5 ${strong ? "text-lg font-bold text-slate-900" : "text-slate-900"}`}>{value}</dd>
    </div>
  );
}
