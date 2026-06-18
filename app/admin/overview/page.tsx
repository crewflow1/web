import Link from "next/link";
import { requireUser } from "@/server/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildHqSnapshot } from "@/server/services/hq-snapshot";
import {
  buildMorningSummary,
  computeMetrics,
  sparklinePoints,
} from "@/lib/hq/metrics";
import {
  AnimatedNumber,
  GlowHeader,
  Panel,
  StatTile,
  Surface,
  type Accent,
} from "@/components/ui";

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
  const growthAccent: Accent =
    metrics.growthPct > 0 ? "emerald" : metrics.growthPct < 0 ? "rose" : "slate";

  return (
    <Surface>
      <GlowHeader
        eyebrow="CrewFlow HQ"
        title="Overview"
        subtitle={`As of ${new Date(snapshot.generatedAt).toLocaleString("en-GB")}`}
      />

      <div className="space-y-6 p-5 sm:p-7">
        {/* Morning summary */}
        <Panel accent="indigo">
          <p className="text-base font-semibold text-white">
            {summary.greeting}
          </p>
          <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-5">
            {summary.bullets.map((b) => (
              <li
                key={b.label}
                className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2"
              >
                <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  {b.label}
                </div>
                <div className="mt-0.5 text-lg font-bold text-white">
                  {b.value}
                </div>
              </li>
            ))}
          </ul>
        </Panel>

        {/* Headline tiles */}
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            accent="emerald"
            label="MRR"
            value={<AnimatedNumber value={metrics.mrrGbp} format="currency" />}
            sub="active × £500"
          />
          <StatTile
            label="Forecast MRR"
            value={
              <AnimatedNumber value={metrics.forecastMrrGbp} format="currency" />
            }
            sub="active + trial"
          />
          <StatTile
            label="Setup fees earned"
            value={
              <AnimatedNumber
                value={metrics.setupFeesEarnedGbp}
                format="currency"
              />
            }
            sub={`${snapshot.setupFees.paid_orgs} × £1,000`}
          />
          <StatTile
            accent={growthAccent}
            label="Growth (30d)"
            value={`${growthSign}${metrics.growthPct.toFixed(1)}%`}
            sub="active customer count"
          />
          <StatTile
            label="Active customers"
            value={<AnimatedNumber value={metrics.activeCustomers} />}
          />
          <StatTile
            label="In onboarding"
            value={<AnimatedNumber value={metrics.activeOnboarding} />}
            sub="trial workspaces"
          />
          <StatTile
            accent="amber"
            label="Pending demos"
            value={<AnimatedNumber value={metrics.pendingDemos} />}
            sub="awaiting first contact"
          />
          <StatTile
            label="Cancelled"
            value={<AnimatedNumber value={metrics.cancelledCustomers} />}
            sub="churned to date"
          />
        </section>

        {/* Sparklines */}
        <section className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <SparkCard
            title="Revenue (12 mo)"
            subtitle="setup fees + MRR per month"
            series={snapshot.series.revenue.map((r) => ({
              x: r.month,
              y: r.revenue,
            }))}
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
            series={snapshot.series.customerGrowth.map((r) => ({
              x: r.month,
              y: r.count,
            }))}
            formatY={(n) => String(n)}
          />
          <SparkCard
            title="Cancellations (12 mo)"
            subtitle="orgs cancelled per month"
            series={snapshot.series.cancellation.map((r) => ({
              x: r.month,
              y: r.count,
            }))}
            formatY={(n) => String(n)}
            tone="rose"
          />
        </section>

        <p className="text-center text-xs text-slate-500">
          <Link
            href="/admin/organizations"
            className="transition hover:text-slate-300"
          >
            Open the legacy organisations view →
          </Link>
        </p>
      </div>
    </Surface>
  );
}

type SparkSeries = ReadonlyArray<{ x: string; y: number }>;

function SparkCard({
  title,
  subtitle,
  series,
  formatY,
  tone = "indigo",
}: {
  title: string;
  subtitle: string;
  series: SparkSeries;
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

  // Empty state — when every bucket is zero, surface a friendlier
  // explanation instead of a flat line.
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
            No data in this window yet. Will fill in as customers activate,
            cancel, or generate revenue.
          </p>
        )}
      </div>
    </div>
  );
}
