import Link from "next/link";
import { requireUser } from "@/server/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildHqSnapshot } from "@/server/services/hq-snapshot";
import {
  buildMorningSummary,
  computeMetrics,
  sparklinePoints,
} from "@/lib/hq/metrics";

/**
 * CrewFlow HQ — Section 1, OVERVIEW.
 *
 * Headline KPI tiles + 4 sparklines + a "morning summary" greeting
 * with five attention-driving numbers. Designed so the CEO opens it
 * over a coffee and knows in 10 seconds where to spend the next hour.
 *
 * Auth: the parent layout (app/admin/layout.tsx) gates on
 * `isSuperAdminEmail` — non-allowlisted hit 404 before reaching here.
 */

const GBP = (n: number) => `£${Math.round(n).toLocaleString("en-GB")}`;

export default async function HqOverviewPage() {
  const user = await requireUser();

  // Pull the user's first name from public.users for the greeting.
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("users")
    .select("full_name")
    .eq("id", user.id)
    .maybeSingle();
  const firstName = profile?.full_name?.split(" ")[0] ?? null;

  const snapshot = await buildHqSnapshot();
  const metrics = computeMetrics(snapshot);
  const summary = buildMorningSummary(metrics, firstName);

  const growthSign = metrics.growthPct > 0 ? "+" : "";
  const growthClass =
    metrics.growthPct > 0
      ? "text-emerald-700"
      : metrics.growthPct < 0
        ? "text-red-700"
        : "text-slate-500";

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-slate-900">Overview</h1>
        <p className="mt-1 text-sm text-slate-600">
          CrewFlow HQ · as of {new Date(snapshot.generatedAt).toLocaleString("en-GB")}
        </p>
      </header>

      {/* Morning summary */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-base font-semibold text-slate-900">
          {summary.greeting}
        </p>
        <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-5">
          {summary.bullets.map((b) => (
            <li
              key={b.label}
              className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2"
            >
              <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                {b.label}
              </div>
              <div className="mt-0.5 text-lg font-bold text-slate-900">
                {b.value}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* Headline tiles */}
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="MRR" value={GBP(metrics.mrrGbp)} sub="active × £500" emphasis />
        <Tile
          label="Forecast MRR"
          value={GBP(metrics.forecastMrrGbp)}
          sub="active + trial"
        />
        <Tile
          label="Setup fees earned"
          value={GBP(metrics.setupFeesEarnedGbp)}
          sub={`${snapshot.setupFees.paid_orgs} × £1,000`}
        />
        <Tile
          label="Growth (30d)"
          value={`${growthSign}${metrics.growthPct.toFixed(1)}%`}
          sub="active customer count"
          valueClass={growthClass}
        />
        <Tile label="Active customers" value={String(metrics.activeCustomers)} />
        <Tile
          label="In onboarding"
          value={String(metrics.activeOnboarding)}
          sub="trial workspaces"
        />
        <Tile
          label="Pending demos"
          value={String(metrics.pendingDemos)}
          sub="awaiting first contact"
          actionHref="/admin/organizations"
          actionLabel="Open"
        />
        <Tile
          label="Cancelled"
          value={String(metrics.cancelledCustomers)}
          sub="churned to date"
        />
      </section>

      {/* Sparklines */}
      <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <SparkCard
          title="Revenue (12 mo)"
          subtitle="setup fees + MRR per month"
          series={snapshot.series.revenue.map((r) => ({ x: r.month, y: r.revenue }))}
          formatY={GBP}
        />
        <SparkCard
          title="MRR (12 mo)"
          subtitle="end-of-month snapshot"
          series={snapshot.series.mrr.map((r) => ({ x: r.month, y: r.mrr }))}
          formatY={GBP}
        />
        <SparkCard
          title="Customer growth (12 mo)"
          subtitle="new active / trial orgs per month"
          series={snapshot.series.customerGrowth.map((r) => ({ x: r.month, y: r.count }))}
          formatY={(n) => String(n)}
        />
        <SparkCard
          title="Cancellations (12 mo)"
          subtitle="orgs cancelled per month"
          series={snapshot.series.cancellation.map((r) => ({ x: r.month, y: r.count }))}
          formatY={(n) => String(n)}
          tone="red"
        />
      </section>

      <p className="text-center text-xs text-slate-400">
        <Link href="/admin/organizations" className="hover:text-slate-700">
          Open the legacy organisations view →
        </Link>
      </p>
    </div>
  );
}

function Tile({
  label,
  value,
  sub,
  emphasis,
  actionHref,
  actionLabel,
  valueClass,
}: {
  label: string;
  value: string;
  sub?: string;
  emphasis?: boolean;
  actionHref?: string;
  actionLabel?: string;
  valueClass?: string;
}) {
  return (
    <div
      className={
        emphasis
          ? "rounded-xl border border-emerald-200 bg-emerald-50 p-4 shadow-sm"
          : "rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
      }
    >
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className={`mt-0.5 text-xl font-bold ${valueClass ?? "text-slate-900"}`}>
        {value}
      </div>
      {sub ? <div className="mt-0.5 text-xs text-slate-500">{sub}</div> : null}
      {actionHref ? (
        <Link
          href={actionHref}
          className="mt-2 inline-block text-[11px] font-semibold text-slate-700 hover:text-slate-900"
        >
          {actionLabel ?? "Open"} →
        </Link>
      ) : null}
    </div>
  );
}

type SparkSeries = ReadonlyArray<{ x: string; y: number }>;

function SparkCard({
  title,
  subtitle,
  series,
  formatY,
  tone = "slate",
}: {
  title: string;
  subtitle: string;
  series: SparkSeries;
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

  // Empty state — when every bucket is zero, surface a friendlier
  // explanation instead of a flat line.
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
            No data in this window yet. Will fill in as customers
            activate, cancel, or generate revenue.
          </p>
        )}
      </div>
    </div>
  );
}
