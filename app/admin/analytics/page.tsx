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
import {
  AnimatedNumber,
  Button,
  ButtonLink,
  GlowHeader,
  Panel,
  StatTile,
  Surface,
  type Accent,
} from "@/components/ui";

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
    <Surface>
      <GlowHeader
        eyebrow="CrewFlow HQ · Analytics"
        title="Executive dashboard"
        subtitle="Deterministic analytics across the customer base. Health scores cached nightly; exec exports for CSV + PDF."
        actions={
          <>
            <ButtonLink href="/admin/overview" variant="glass" size="sm">
              ← HQ overview
            </ButtonLink>
            <ButtonLink
              href="/api/admin/analytics/export.csv"
              variant="glass"
              size="sm"
              external
            >
              Export CSV
            </ButtonLink>
            <ButtonLink
              href="/api/admin/analytics/export.pdf"
              variant="glass"
              size="sm"
              external
              target="_blank"
              rel="noreferrer noopener"
            >
              Export PDF
            </ButtonLink>
          </>
        }
      />

      <div className="space-y-6 p-5 sm:p-7">
        {banner ? (
          <div
            className={`rounded-lg border px-3 py-2 text-sm ${
              banner.tone === "ok"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                : "border-rose-500/30 bg-rose-500/10 text-rose-200"
            }`}
          >
            {banner.msg}
          </div>
        ) : null}

        {/* ============================================================ */}
        {/* AI COO INSIGHTS PANEL                                         */}
        {/* ============================================================ */}
        <Panel
          accent="indigo"
          title="AI COO insights · deterministic"
          subtitle="Bullet observations across revenue, churn risk, and the customer portfolio. LLM-generated narrative lands later — same shape."
        >
          {insights.length === 0 ? (
            <p className="mt-3 rounded-xl border border-dashed border-slate-800 bg-slate-900/60 px-4 py-4 text-center text-sm text-slate-500">
              Nothing notable — portfolio is steady.
            </p>
          ) : (
            <ul className="mt-1 grid gap-2 md:grid-cols-2">
              {insights.map((i) => (
                <InsightCard key={i.id} insight={i} />
              ))}
            </ul>
          )}
        </Panel>

        {/* ============================================================ */}
        {/* 1. REVENUE ANALYTICS                                          */}
        {/* ============================================================ */}
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-500">
            1 · Revenue
          </h2>
          <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Kpi label="MRR" value={<AnimatedNumber value={revenue.mrrGbp} format="currency" />} accent="emerald" />
            <Kpi label="ARR" value={<AnimatedNumber value={revenue.arrGbp} format="currency" />} accent="emerald" />
            <Kpi
              label="Growth %"
              value={fmtPct(revenue.growthPct)}
              accent={revenue.growthPct >= 0 ? "emerald" : "rose"}
            />
            <Kpi
              label="Churn % 30d"
              value={fmtPct(revenue.churnPct)}
              accent={revenue.churnPct > 5 ? "rose" : "slate"}
            />
            <Kpi
              label="Forecast 90d"
              value={<AnimatedNumber value={revenue.forecast90dGbp} format="currency" />}
              accent="slate"
            />
            <Kpi
              label="Avg customer value"
              value={<AnimatedNumber value={revenue.avgCustomerValueGbp} format="currency" />}
              accent="slate"
            />
            <Kpi
              label="Outstanding"
              value={<AnimatedNumber value={revenue.outstandingGbp} format="currency" />}
              accent={revenue.outstandingGbp > 5000 ? "rose" : "amber"}
            />
            <Kpi
              label="Lost revenue"
              value={<AnimatedNumber value={revenue.lostRevenueGbp} format="currency" />}
              accent="rose"
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
              tone="rose"
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
              accent="emerald"
            />
            <Kpi
              label="At risk (40–69)"
              value={String(customer.atRisk)}
              accent="amber"
            />
            <Kpi
              label="Critical (<40)"
              value={String(customer.critical)}
              accent="rose"
            />
            <Kpi
              label="Unscored"
              value={String(customer.unscored)}
              accent="slate"
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
                        className="font-medium text-indigo-300 hover:text-indigo-200"
                      >
                        {c.name}
                      </Link>
                      <span className="text-rose-300">
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
              accent={
                benchmarks.averageHealth !== null && benchmarks.averageHealth < 50
                  ? "rose"
                  : "slate"
              }
            />
            <Kpi
              label="Avg MRR"
              value={<AnimatedNumber value={benchmarks.averageMrrGbp} format="currency" />}
              accent="slate"
            />
            <Kpi
              label="Avg LTV"
              value={<AnimatedNumber value={benchmarks.averageLtvGbp} format="currency" />}
              accent="slate"
            />
            <Kpi
              label="Avg migration days"
              value={
                benchmarks.averageMigrationDays !== null
                  ? `${benchmarks.averageMigrationDays} days`
                  : "—"
              }
              accent="slate"
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
                        className="font-medium text-indigo-300 hover:text-indigo-200"
                      >
                        {c.name}
                      </Link>
                      <span className="text-slate-300">
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
                        className="font-medium text-indigo-300 hover:text-indigo-200"
                      >
                        {c.name}
                      </Link>
                      <span className="text-slate-300">
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
                        className="font-medium text-indigo-300 hover:text-indigo-200"
                      >
                        {c.name}
                      </Link>
                      <span className="text-emerald-300">
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
          <div className="mt-2 rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-white">
                  Cached health scores
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  Nightly cron at{" "}
                  <code className="rounded bg-slate-800/80 px-1 font-mono text-[0.9em] text-slate-300 ring-1 ring-inset ring-slate-700">
                    /api/cron/health-recompute
                  </code>{" "}
                  rebuilds the cache. Trigger an immediate recompute below — only
                  scores that actually change get written.
                </p>
              </div>
              <form action={recomputeHealthNow}>
                <Button type="submit" variant="accent" size="md">
                  Recompute health now
                </Button>
              </form>
            </div>
            <div className="mt-4">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Recent health changes
              </p>
              {healthEvents.length === 0 ? (
                <p className="mt-2 rounded-xl border border-dashed border-slate-800 bg-slate-900/60 px-3 py-3 text-center text-xs text-slate-500">
                  No recompute events yet. Run the cron or click &ldquo;Recompute
                  health now&rdquo; to populate.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-slate-800 text-xs">
                  {healthEvents.map((e) => (
                    <li
                      key={e.id}
                      className="flex flex-wrap items-baseline justify-between gap-2 py-2"
                    >
                      <div>
                        <Link
                          href={`/admin/customers/${e.org_id}`}
                          className="font-medium text-indigo-300 hover:text-indigo-200"
                        >
                          {e.org_id.slice(0, 8)}…
                        </Link>
                        <span className="ml-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                          {e.trigger}
                        </span>
                      </div>
                      <div className="text-slate-300">
                        {e.old_score ?? "—"} →{" "}
                        <span
                          className={
                            (e.delta ?? 0) >= 0
                              ? "font-semibold text-emerald-300"
                              : "font-semibold text-rose-300"
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

        <footer className="border-t border-slate-800 pt-3 text-[11px] text-slate-500">
          Snapshot generated {snap.generatedAt.slice(0, 19).replace("T", " ")} UTC ·
          Deterministic compute · No LLM. LLM rerank lands later without changing
          this surface.
        </footer>
      </div>
    </Surface>
  );
}

// =====================================================================
// Bits
// =====================================================================

function InsightCard({ insight }: { insight: Insight }) {
  const colour =
    insight.kind === "positive"
      ? "border-emerald-500/30 bg-emerald-500/10"
      : insight.kind === "negative"
        ? "border-rose-500/30 bg-rose-500/10"
        : "border-slate-800 bg-slate-900/60";
  return (
    <li className={`rounded-xl border p-3 ${colour}`}>
      <p className="text-sm font-semibold text-white">{insight.headline}</p>
      <p className="mt-1 text-xs text-slate-300">{insight.detail}</p>
    </li>
  );
}

function Kpi({
  label,
  value,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  accent: Accent;
}) {
  return <StatTile label={label} value={value} accent={accent} />;
}

function Tile({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
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
      <span className="font-medium text-slate-100">{value}</span>
    </div>
  );
}

function SparkCard({
  title,
  subtitle,
  series,
  formatY,
  tone = "indigo",
}: {
  title: string;
  subtitle: string;
  series: ReadonlyArray<{ x: string; y: number }>;
  formatY: (n: number) => string;
  tone?: "indigo" | "rose";
}) {
  const width = 360;
  const height = 56;
  const points = sparklinePoints(
    series.map((s) => ({ month: s.x, count: s.y })),
    "count",
    width,
    height,
  );
  const stroke = tone === "rose" ? "#fb7185" : "#818cf8";
  const last = series.length > 0 ? series[series.length - 1] : null;
  const prev = series.length >= 2 ? series[series.length - 2] : null;
  const hasAnyData = series.some((s) => s.y > 0);
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex items-baseline justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          <p className="mt-0.5 text-[11px] text-slate-500">{subtitle}</p>
        </div>
        {last ? (
          <div className="text-right">
            <div className="text-base font-bold text-white">
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
            <path
              d={points.d}
              fill="none"
              stroke={stroke}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <p className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-3 text-center text-[11px] text-slate-500">
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
