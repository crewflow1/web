import Link from "next/link";
import {
  AnimatedNumber,
  Button,
  ButtonLink,
  GlowHeader,
  Input,
  Select,
  StatTile,
  Surface,
} from "@/components/ui";
import { listHealthDeepDive } from "@/server/services/hq-health-deep-dive";
import {
  bandFromScore,
  HEALTH_BAND_LABEL,
  applyHealthFilter,
  recommendForRow,
  HEALTH_FILTER_LABEL,
  type HealthBand,
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

// Dark band pills — mirror the light HEALTH_BAND_PILL shape from
// lib/hq/health-deep-dive on the dark canvas.
const BAND_PILL: Record<HealthBand, string> = {
  red: "bg-rose-500/15 text-rose-300 ring-1 ring-inset ring-rose-400/30",
  yellow: "bg-amber-500/15 text-amber-300 ring-1 ring-inset ring-amber-400/30",
  green: "bg-emerald-500/15 text-emerald-300 ring-1 ring-inset ring-emerald-400/30",
  unknown: "bg-slate-700/40 text-slate-300 ring-1 ring-inset ring-slate-600/40",
};

// Trend sparkline number colours, keyed by the same band as the pills so
// the score history reads through the single bandFromScore derivation.
const BAND_TREND_TEXT: Record<HealthBand, string> = {
  red: "text-rose-300",
  yellow: "text-amber-300",
  green: "text-emerald-300",
  unknown: "text-slate-400",
};

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
    <Surface>
      <GlowHeader
        eyebrow="CrewFlow HQ"
        title="Churn + upsell control room"
        subtitle={
          <>
            Per-customer health with deterministic next-best-action. Critical
            (&lt;40) first. Filters narrow by band or operator queue.
            Recommendations are pure rules — no LLM.
          </>
        }
      />

      <div className="space-y-5 p-5 sm:p-7">
        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile label="Critical" value={<AnimatedNumber value={red} />} accent="rose" />
          <StatTile label="At risk" value={<AnimatedNumber value={yellow} />} accent="amber" />
          <StatTile label="Healthy" value={<AnimatedNumber value={green} />} accent="emerald" />
          <StatTile label="Unscored" value={<AnimatedNumber value={unscored} />} accent="slate" />
        </section>

        <form
          method="get"
          action="/admin/health"
          className="flex flex-wrap items-end gap-2 rounded-2xl border border-slate-800 bg-slate-900/40 p-3"
        >
          <label className="flex flex-col text-[11px] font-medium text-slate-400">
            Filter
            <Select name="filter" defaultValue={filter} className="mt-1">
              {(Object.keys(HEALTH_FILTER_LABEL) as HealthDeepDiveFilter[]).map(
                (k) => (
                  <option key={k} value={k}>
                    {HEALTH_FILTER_LABEL[k]}
                  </option>
                ),
              )}
            </Select>
          </label>
          <label className="flex flex-col text-[11px] font-medium text-slate-400">
            Search
            <Input
              type="text"
              name="q"
              defaultValue={q}
              placeholder="customer name"
              className="mt-1 w-56"
            />
          </label>
          <Button type="submit" variant="accent" size="sm">
            Apply
          </Button>
          <ButtonLink href="/admin/health" variant="glass" size="sm">
            Reset
          </ButtonLink>
        </form>

        {recs.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-slate-800 bg-slate-900/30 px-4 py-6 text-center text-sm text-slate-500">
            No customers match this filter.
          </p>
        ) : (
          <ul className="space-y-3">
            {recs.map(({ row, rec }) => {
              const band = bandFromScore(row.health_score);
              return (
                <li
                  key={row.org_id}
                  className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${BAND_PILL[band]}`}
                        >
                          {HEALTH_BAND_LABEL[band]}
                        </span>
                        <Link
                          href={`/admin/customers/${row.org_id}`}
                          className="text-sm font-bold text-white transition-colors hover:text-slate-300"
                        >
                          {row.org_name}
                        </Link>
                        <span className="text-[11px] text-slate-500">
                          {row.status}
                        </span>
                      </div>
                      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-300 sm:grid-cols-4">
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
                              className={BAND_TREND_TEXT[bandFromScore(t.score)]}
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
                          <ButtonLink
                            href={rec.action_url}
                            variant="accent"
                            size="sm"
                          >
                            {rec.label} →
                          </ButtonLink>
                          <p className="text-[10px] text-slate-500">
                            {rec.detail}
                          </p>
                        </>
                      ) : (
                        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-400/30">
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
    </Surface>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[9px] uppercase tracking-wide text-slate-500">
        {label}
      </p>
      <p className="text-[11px] font-medium text-slate-100">{value}</p>
    </div>
  );
}
