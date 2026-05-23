import Link from "next/link";
import { listHealthDeepDive } from "@/server/services/hq-health-deep-dive";
import {
  bandFromScore,
  HEALTH_BAND_LABEL,
  HEALTH_BAND_PILL,
  applyHealthFilter,
  recommendForRow,
  HEALTH_FILTER_LABEL,
  type HealthDeepDiveFilter,
} from "@/lib/hq/health-deep-dive";

/**
 * Customer Health Deep Dive — /admin/health (HQ-11).
 *
 * One row per customer with everything the operator needs to
 * triage churn risk + upsell opportunity:
 *   * Cached health score + 5-event trend sparkline
 *   * MRR + setup-fee state + outstanding £
 *   * Login freshness + days-since-signup
 *   * Onboarding + migration %
 *   * Active + urgent support tickets
 *   * Notifications volume (last 7d)
 *   * Deterministic "next best action" recommendation
 *
 * Filters cover the bands (red/yellow/green) + operator buckets
 * (inactive / unpaid / onboarding stuck / high support volume).
 */

type SP = Promise<{ filter?: string; q?: string }>;

export const dynamic = "force-dynamic";

export default async function HqHealthPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;
  const filter = (sp.filter as HealthDeepDiveFilter | undefined) ?? "all";
  const q = (sp.q ?? "").trim().toLowerCase();

  const rows = await listHealthDeepDive();
  const filtered = q
    ? rows.filter((r) => r.org_name.toLowerCase().includes(q))
    : rows;
  const banded = applyHealthFilter(filtered, filter);

  // KPI tiles (full unfiltered set so the operator sees system truth).
  const red = rows.filter((r) => bandFromScore(r.health_score) === "red").length;
  const yellow = rows.filter(
    (r) => bandFromScore(r.health_score) === "yellow",
  ).length;
  const green = rows.filter(
    (r) => bandFromScore(r.health_score) === "green",
  ).length;
  const unscored = rows.filter((r) => r.health_score === null).length;

  // Recommendations + sort: rows with recommendations (by weight desc)
  // first, then unscored, then healthy.
  const recs = banded.map((r) => ({ row: r, rec: recommendForRow(r) }));
  recs.sort((a, b) => {
    const wa = a.rec?.weight ?? -1;
    const wb = b.rec?.weight ?? -1;
    if (wa !== wb) return wb - wa;
    const sa = a.row.health_score ?? 999;
    const sb = b.row.health_score ?? 999;
    return sa - sb;
  });

  return (
    <div className="space-y-5 p-6">
      <header>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          HQ · Customer health
        </p>
        <h1 className="text-2xl font-bold text-slate-900">
          Churn + upsell control room
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          Per-customer health with deterministic next-best-action. Critical
          (&lt;40) first. Filters narrow by band or operator queue.
          Recommendations are pure rules — no LLM.
        </p>
      </header>

      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Critical" value={String(red)} tone="red" />
        <Kpi label="At risk" value={String(yellow)} tone="amber" />
        <Kpi label="Healthy" value={String(green)} tone="emerald" />
        <Kpi label="Unscored" value={String(unscored)} tone="slate" />
      </section>

      <form
        method="get"
        action="/admin/health"
        className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
      >
        <label className="flex flex-col text-[11px] font-medium text-slate-700">
          Filter
          <select
            name="filter"
            defaultValue={filter}
            className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            {(Object.keys(HEALTH_FILTER_LABEL) as HealthDeepDiveFilter[]).map(
              (k) => (
                <option key={k} value={k}>
                  {HEALTH_FILTER_LABEL[k]}
                </option>
              ),
            )}
          </select>
        </label>
        <label className="flex flex-col text-[11px] font-medium text-slate-700">
          Search
          <input
            type="text"
            name="q"
            defaultValue={q}
            placeholder="customer name"
            className="mt-1 w-56 rounded-md border border-slate-300 px-3 py-1.5 text-sm"
          />
        </label>
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700"
        >
          Apply
        </button>
        <Link
          href="/admin/health"
          className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
        >
          Reset
        </Link>
      </form>

      {recs.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500">
          No customers match this filter.
        </p>
      ) : (
        <ul className="space-y-3">
          {recs.map(({ row, rec }) => {
            const band = bandFromScore(row.health_score);
            return (
              <li
                key={row.org_id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${HEALTH_BAND_PILL[band]}`}
                      >
                        {HEALTH_BAND_LABEL[band]}
                      </span>
                      <Link
                        href={`/admin/customers/${row.org_id}`}
                        className="text-sm font-bold text-slate-900 hover:underline"
                      >
                        {row.org_name}
                      </Link>
                      <span className="text-[11px] text-slate-500">
                        {row.status}
                      </span>
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-700 sm:grid-cols-4">
                      <Stat
                        label="Health"
                        value={
                          row.health_score !== null
                            ? `${row.health_score}/100`
                            : "—"
                        }
                      />
                      <Stat
                        label="MRR"
                        value={`£${Math.round(row.mrr_gbp).toLocaleString("en-GB")}`}
                      />
                      <Stat label="Setup fee" value={row.setup_fee_status} />
                      <Stat
                        label="Outstanding"
                        value={
                          row.outstanding_gbp > 0
                            ? `£${Math.round(row.outstanding_gbp).toLocaleString("en-GB")}`
                            : "—"
                        }
                      />
                      <Stat
                        label="Last login"
                        value={
                          row.days_since_login === null
                            ? "Never"
                            : row.days_since_login === 0
                              ? "Today"
                              : `${row.days_since_login}d ago`
                        }
                      />
                      <Stat
                        label="Onboarded"
                        value={`${row.onboarding_percent}%`}
                      />
                      <Stat
                        label="Migration"
                        value={`${row.migration_percent}%`}
                      />
                      <Stat
                        label="Active tickets"
                        value={
                          row.active_support_tickets === 0
                            ? "0"
                            : `${row.active_support_tickets}${row.urgent_support_tickets > 0 ? ` (${row.urgent_support_tickets} urgent)` : ""}`
                        }
                      />
                    </dl>
                    {row.trend.length > 1 ? (
                      <div className="mt-2 flex items-center gap-1 text-[10px] text-slate-500">
                        <span>Trend:</span>
                        {row.trend.map((t, i) => (
                          <span
                            key={i}
                            className={
                              t.score < 40
                                ? "text-red-700"
                                : t.score < 70
                                  ? "text-amber-700"
                                  : "text-emerald-700"
                            }
                          >
                            {t.score}
                            {i < row.trend.length - 1 ? " →" : ""}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex w-full flex-col items-end gap-1 sm:w-auto">
                    {rec ? (
                      <>
                        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                          Recommended
                        </p>
                        <Link
                          href={rec.action_url}
                          className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                        >
                          {rec.label} →
                        </Link>
                        <p className="text-[10px] text-slate-500">
                          {rec.detail}
                        </p>
                      </>
                    ) : (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-900">
                        No action needed
                      </span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "red" | "amber" | "emerald" | "slate";
}) {
  const t: Record<typeof tone, string> = {
    red: "bg-red-50 border-red-200 text-red-900",
    amber: "bg-amber-50 border-amber-200 text-amber-900",
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-900",
    slate: "bg-white border-slate-200 text-slate-900",
  };
  return (
    <div className={`rounded-xl border p-3 shadow-sm ${t[tone]}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wide opacity-75">
        {label}
      </p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="text-[11px] font-medium text-slate-900">{value}</p>
    </div>
  );
}
