import Link from "next/link";
import {
  buildAnalyticsSnapshot,
  pickHighestRiskCustomers,
} from "@/server/services/hq-analytics-snapshot";
import {
  computeRevenueAnalytics,
  computeCustomerAnalytics,
  computeBenchmarks,
  buildInsightsPanel,
  type Insight,
} from "@/lib/hq/analytics";
import { sparklinePoints } from "@/lib/hq/metrics";
import { listRecentHealthEvents } from "@/server/services/hq-health-recompute";
import { recomputeHealthNow } from "./actions";

/**
 * Analytics + Health Engine — HQ-6.
 *
 * Sections:
 *   1. Revenue analytics — MRR / ARR / growth / churn / forecast /
 *      outstanding / paid / lost revenue + 4 sparklines (revenue,
 *      MRR, customer growth, cancellations).
 *   2. Customer analytics — health distribution / migration stats /
 *      usage trends.
 *   3. AI COO insights panel — deterministic textual bullets.
 *   4. Benchmarking — averages + top performers.
 *   5. Health engine — cached score with "recompute now" button +
 *      recent health_score_events stream.
 *   6. Export — CSV + PDF.
 *
 * Everything reads from the cached organizations.health_score
 * column (populated by the nightly cron at /api/cron/health-recompute).
 */

type SP = Promise<{
  saved?: string;
  processed?: string;
  changed?: string;
  error?: string;
}>;

export const dynamic = "force-dynamic";

export default async function HqAnalyticsPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const sp = await searchParams;

  const snap = await buildAnalyticsSnapshot();
  const revenue = computeRevenueAnalytics(snap);
  const customer = computeCustomerAnalytics(snap);
  const benchmarks = computeBenchmarks(snap);
  const highestRisk = pickHighestRiskCustomers(snap);
  const insights = buildInsightsPanel(revenue, customer, benchmarks, highestRisk);
  const healthEvents = await listRecentHealthEvents(15);

  const banner = (() => {
    if (sp.saved === "1") {
      return {
        tone: "ok" as const,
        msg: `Recompute complete · ${sp.processed ?? "?"} orgs processed · ${sp.changed ?? "?"} changed.`,
      };
    }
    if (sp.error)
      return { tone: "err" as const, msg: "Action failed — see logs." };
    return null;
  })();

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
            HQ · Analytics
          </p>
          <h1 className="text-2xl font-bold text-slate-900">
            Executive dashboard
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Deterministic analytics across the customer base. Health scores
            cached nightly; exec exports for CSV + PDF.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/admin/overview"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            ← HQ overview
          </Link>
          <a
            href="/api/admin/analytics/export.csv"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Export CSV
          </a>
          <a
            href="/api/admin/analytics/export.pdf"
            target="_blank"
            rel="noreferrer noopener"
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Export PDF
          </a>
        </div>
      </header>

      {banner ? (
        <div
          className={`rounded-md border px-3 py-2 text-sm ${
            banner.tone === "ok"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border-red-200 bg-red-50 text-red-800"
          }`}
        >
          {banner.msg}
        </div>
      ) : null}

      {/* ============================================================ */}
      {/* AI COO INSIGHTS PANEL                                         */}
      {/* ============================================================ */}
      <section className="rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50 via-white to-white p-5 shadow-sm">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-indigo-700">
          AI COO insights · deterministic
        </p>
        <p className="text-xs text-slate-600">
          Bullet observations across revenue, churn risk, and the customer
          portfolio. LLM-generated narrative lands later — same shape.
        </p>
        {insights.length === 0 ? (
          <p className="mt-3 rounded-md border border-dashed border-indigo-200 bg-white px-4 py-4 text-center text-sm text-slate-500">
            Nothing notable — portfolio is steady.
          </p>
        ) : (
          <ul className="mt-4 grid gap-2 md:grid-cols-2">
            {insights.map((i) => (
              <InsightCard key={i.id} insight={i} />
            ))}
          </ul>
        )}
      </section>

      {/* ============================================================ */}
      {/* 1. REVENUE ANALYTICS                                          */}
      {/* ============================================================ */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
          1 · Revenue
        </h2>
        <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi label="MRR" value={fmtGbp(revenue.mrrGbp)} tone="emerald" />
          <Kpi label="ARR" value={fmtGbp(revenue.arrGbp)} tone="emerald" />
          <Kpi
            label="Growth %"
            value={fmtPct(revenue.growthPct)}
            tone={revenue.growthPct >= 0 ? "emerald" : "red"}
          />
          <Kpi
            label="Churn % 30d"
            value={fmtPct(revenue.churnPct)}
            tone={revenue.churnPct > 5 ? "red" : "slate"}
          />
          <Kpi
            label="Forecast 90d"
            value={fmtGbp(revenue.forecast90dGbp)}
            tone="slate"
          />
          <Kpi
            label="Avg customer value"
            value={fmtGbp(revenue.avgCustomerValueGbp)}
            tone="slate"
          />
          <Kpi
            label="Outstanding"
            value={fmtGbp(revenue.outstandingGbp)}
            tone={revenue.outstandingGbp > 5000 ? "red" : "amber"}
          />
          <Kpi
            label="Lost revenue"
            value={fmtGbp(revenue.lostRevenueGbp)}
            tone="red"
          />
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <SparkCard
            title="Revenue trend (12 mo)"
            subtitle="Setup + subscription paid invoices per UTC month"
            series={revenue.series.revenue.map((p) => ({
              x: p.month,
              y: p.revenue,
            }))}
            formatY={(n) => fmtGbp(n)}
          />
          <SparkCard
            title="MRR growth (12 mo)"
            subtitle="Active+trial × £500 at month end"
            series={revenue.series.mrr.map((p) => ({ x: p.month, y: p.mrr }))}
            formatY={(n) => fmtGbp(n)}
          />
          <SparkCard
            title="Customer growth (12 mo)"
            subtitle="New active customers per UTC month"
            series={revenue.series.customerGrowth.map((p) => ({
              x: p.month,
              y: p.count,
            }))}
            formatY={(n) => String(n)}
          />
          <SparkCard
            title="Churn trend (12 mo)"
            subtitle="Cancellations per UTC month"
            series={revenue.series.cancellation.map((p) => ({
              x: p.month,
              y: p.count,
            }))}
            formatY={(n) => String(n)}
            tone="red"
          />
        </div>
      </section>

      {/* ============================================================ */}
      {/* 2. CUSTOMER ANALYTICS                                         */}
      {/* ============================================================ */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
          2 · Customers
        </h2>

        <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi
            label="Healthy (≥70)"
            value={String(customer.healthy)}
            tone="emerald"
          />
          <Kpi
            label="At risk (40–69)"
            value={String(customer.atRisk)}
            tone="amber"
          />
          <Kpi
            label="Critical (<40)"
            value={String(customer.critical)}
            tone="red"
          />
          <Kpi
            label="Unscored"
            value={String(customer.unscored)}
            tone="slate"
          />
        </div>

        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <Tile title="Migration">
            <Field
              label="Avg completion"
              value={`${customer.migration.averagePct}%`}
            />
            <Field
              label="Avg days to complete"
              value={
                customer.migration.averageDaysToComplete !== null
                  ? `${customer.migration.averageDaysToComplete} days`
                  : "—"
              }
            />
            <Field
              label="Fastest"
              value={
                customer.migration.fastestDays !== null
                  ? `${customer.migration.fastestDays} days`
                  : "—"
              }
            />
            <Field
              label="Stalled (>7d)"
              value={String(customer.migration.stalledCount)}
            />
            <Field
              label="Completed"
              value={String(customer.migration.completedCount)}
            />
          </Tile>
          <Tile title="Usage">
            <Field
              label="Active last 7 days"
              value={String(customer.usage.activeLast7Days)}
            />
            <Field
              label="Active last 30 days"
              value={String(customer.usage.activeLast30Days)}
            />
            <Field
              label="Never logged in"
              value={String(customer.usage.neverLoggedIn)}
            />
            <Field
              label="Avg days since login"
              value={
                customer.usage.averageDaysSinceLogin !== null
                  ? `${customer.usage.averageDaysSinceLogin} days`
                  : "—"
              }
            />
          </Tile>
          <Tile title="Highest risk customers">
            {highestRisk.length === 0 ? (
              <p className="text-xs text-slate-500">
                No customers in the critical band.
              </p>
            ) : (
              <ul className="space-y-1">
                {highestRisk.map((c) => (
                  <li key={c.id} className="flex justify-between text-xs">
                    <Link
                      href={`/admin/customers/${c.id}`}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {c.name}
                    </Link>
                    <span className="text-red-700">
                      Health {c.health} · {fmtGbp(c.mrr)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Tile>
        </div>
      </section>

      {/* ============================================================ */}
      {/* 3. BENCHMARKING                                               */}
      {/* ============================================================ */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
          3 · Benchmarking
        </h2>
        <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi
            label="Avg health"
            value={
              benchmarks.averageHealth !== null
                ? `${benchmarks.averageHealth}/100`
                : "—"
            }
            tone={
              benchmarks.averageHealth !== null && benchmarks.averageHealth < 50
                ? "red"
                : "slate"
            }
          />
          <Kpi
            label="Avg MRR"
            value={fmtGbp(benchmarks.averageMrrGbp)}
            tone="slate"
          />
          <Kpi
            label="Avg LTV"
            value={fmtGbp(benchmarks.averageLtvGbp)}
            tone="slate"
          />
          <Kpi
            label="Avg migration days"
            value={
              benchmarks.averageMigrationDays !== null
                ? `${benchmarks.averageMigrationDays} days`
                : "—"
            }
            tone="slate"
          />
        </div>
        <div className="mt-3 grid gap-3 md:grid-cols-3">
          <Tile title="Top by MRR">
            {benchmarks.topByMrr.length === 0 ? (
              <p className="text-xs text-slate-500">No customers yet.</p>
            ) : (
              <ul className="space-y-1">
                {benchmarks.topByMrr.map((c) => (
                  <li key={c.id} className="flex justify-between text-xs">
                    <Link
                      href={`/admin/customers/${c.id}`}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {c.name}
                    </Link>
                    <span className="text-slate-700">
                      {fmtGbp(c.mrr)} · H {c.health ?? "—"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Tile>
          <Tile title="Top by LTV">
            {benchmarks.topByLtv.length === 0 ? (
              <p className="text-xs text-slate-500">No customers yet.</p>
            ) : (
              <ul className="space-y-1">
                {benchmarks.topByLtv.map((c) => (
                  <li key={c.id} className="flex justify-between text-xs">
                    <Link
                      href={`/admin/customers/${c.id}`}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {c.name}
                    </Link>
                    <span className="text-slate-700">
                      {fmtGbp(c.ltv)} · H {c.health ?? "—"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Tile>
          <Tile title="Top by health">
            {benchmarks.topByHealth.length === 0 ? (
              <p className="text-xs text-slate-500">No customers scored.</p>
            ) : (
              <ul className="space-y-1">
                {benchmarks.topByHealth.map((c) => (
                  <li key={c.id} className="flex justify-between text-xs">
                    <Link
                      href={`/admin/customers/${c.id}`}
                      className="font-medium text-slate-900 hover:underline"
                    >
                      {c.name}
                    </Link>
                    <span className="text-emerald-700">
                      {c.health}/100 · {fmtGbp(c.mrr)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Tile>
        </div>
      </section>

      {/* ============================================================ */}
      {/* 4. HEALTH ENGINE                                              */}
      {/* ============================================================ */}
      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
          4 · Health engine
        </h2>
        <div className="mt-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p className="text-sm font-semibold text-slate-900">
                Cached health scores
              </p>
              <p className="mt-1 text-xs text-slate-600">
                Nightly cron at{" "}
                <code className="rounded bg-slate-100 px-1 py-0.5 text-[11px]">
                  /api/cron/health-recompute
                </code>{" "}
                rebuilds the cache. Trigger an immediate recompute below — only
                scores that actually change get written.
              </p>
            </div>
            <form action={recomputeHealthNow}>
              <button
                type="submit"
                className="rounded-md bg-indigo-700 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-800"
              >
                Recompute health now
              </button>
            </form>
          </div>
          <div className="mt-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Recent health changes
            </p>
            {healthEvents.length === 0 ? (
              <p className="mt-2 rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 py-3 text-center text-xs text-slate-500">
                No recompute events yet. Run the cron or click &ldquo;Recompute
                health now&rdquo; to populate.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-slate-100 text-xs">
                {healthEvents.map((e) => (
                  <li
                    key={e.id}
                    className="flex flex-wrap items-baseline justify-between gap-2 py-2"
                  >
                    <div>
                      <Link
                        href={`/admin/customers/${e.org_id}`}
                        className="font-medium text-slate-900 hover:underline"
                      >
                        {e.org_id.slice(0, 8)}…
                      </Link>
                      <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                        {e.trigger}
                      </span>
                    </div>
                    <div className="text-slate-700">
                      {e.old_score ?? "—"} →{" "}
                      <span
                        className={
                          (e.delta ?? 0) >= 0
                            ? "font-semibold text-emerald-700"
                            : "font-semibold text-red-700"
                        }
                      >
                        {e.new_score}
                      </span>
                      <span className="ml-2 text-[10px] text-slate-500">
                        {e.recomputed_at.slice(0, 19).replace("T", " ")} UTC
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <footer className="border-t border-slate-200 pt-3 text-[11px] text-slate-500">
        Snapshot generated {snap.generatedAt.slice(0, 19).replace("T", " ")} UTC ·
        Deterministic compute · No LLM. LLM rerank lands later without changing
        this surface.
      </footer>
    </div>
  );
}

// =====================================================================
// Bits
// =====================================================================

function InsightCard({ insight }: { insight: Insight }) {
  const colour =
    insight.kind === "positive"
      ? "border-emerald-200 bg-emerald-50"
      : insight.kind === "negative"
        ? "border-red-200 bg-red-50"
        : "border-slate-200 bg-white";
  return (
    <li className={`rounded-lg border p-3 ${colour}`}>
      <p className="text-sm font-semibold text-slate-900">{insight.headline}</p>
      <p className="mt-1 text-xs text-slate-700">{insight.detail}</p>
    </li>
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
  const colourise: Record<typeof tone, string> = {
    red: "bg-red-50 border-red-200 text-red-900",
    amber: "bg-amber-50 border-amber-200 text-amber-900",
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-900",
    slate: "bg-white border-slate-200 text-slate-900",
  };
  return (
    <div className={`rounded-xl border p-3 shadow-sm ${colourise[tone]}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wide opacity-75">
        {label}
      </p>
      <p className="mt-1 text-xl font-bold">{value}</p>
    </div>
  );
}

function Tile({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
        {title}
      </p>
      <div className="mt-2 space-y-1">{children}</div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium text-slate-900">{value}</span>
    </div>
  );
}

function SparkCard({
  title,
  subtitle,
  series,
  formatY,
  tone = "slate",
}: {
  title: string;
  subtitle: string;
  series: ReadonlyArray<{ x: string; y: number }>;
  formatY: (n: number) => string;
  tone?: "slate" | "red";
}) {
  const width = 360;
  const height = 56;
  const points = sparklinePoints(
    series.map((s) => ({ month: s.x, count: s.y })),
    "count",
    width,
    height,
  );
  const stroke = tone === "red" ? "#b91c1c" : "#0f172a";
  const last = series.length > 0 ? series[series.length - 1] : null;
  const prev = series.length >= 2 ? series[series.length - 2] : null;
  const hasAnyData = series.some((s) => s.y > 0);
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-baseline justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
          <p className="mt-0.5 text-[11px] text-slate-500">{subtitle}</p>
        </div>
        {last ? (
          <div className="text-right">
            <div className="text-base font-bold text-slate-900">
              {formatY(last.y)}
            </div>
            {prev ? (
              <div className="text-[11px] text-slate-500">
                from {formatY(prev.y)}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="mt-3">
        {hasAnyData ? (
          <svg
            viewBox={`0 0 ${width} ${height}`}
            preserveAspectRatio="none"
            className="block h-14 w-full"
            aria-hidden
          >
            <path d={points.d} fill="none" stroke={stroke} strokeWidth="2" />
          </svg>
        ) : (
          <p className="rounded-md bg-slate-50 px-3 py-3 text-center text-[11px] text-slate-500">
            No data in this window yet.
          </p>
        )}
      </div>
    </div>
  );
}

function fmtGbp(n: number): string {
  return `£${Math.round(n).toLocaleString("en-GB")}`;
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}
