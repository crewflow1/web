/**
 * CrewFlow HQ — Analytics pure compute (HQ-6).
 *
 * Server/client-safe — no Supabase imports. The analytics page
 * (`app/admin/analytics/page.tsx`) renders these directly, and the
 * CSV/PDF export routes serialise them.
 *
 * Business model (CEO directive):
 *   - £1,000 one-off setup fee per customer
 *   - £500/month per active or trial customer
 *   - Premium B2B SaaS — no free tier
 *
 * Everything here is DETERMINISTIC. Future LLM rerankers / summary
 * generators layer on top — they don't replace these numbers.
 */

import type { HqSnapshot } from "@/lib/hq/metrics";
import { MONTHLY_PRICE_GBP } from "@/lib/hq/metrics";

// ---------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------

/** One row per org for the analytics snapshot. */
export type AnalyticsOrg = {
  id: string;
  name: string;
  status: string;
  mrr_gbp: number;
  ltv_gbp: number;
  health_score: number | null;
  setup_fee_paid: boolean;
  approved_at: string | null;
  cancelled_at: string | null;
  trial_ends_at: string | null;
  last_login_at: string | null;
  onboarding_percent: number;
  migration_percent: number;
  /** Days between approved_at and the migration reaching 100% — null
   * when migration isn't yet complete or the org hasn't been approved. */
  migration_days: number | null;
  created_at: string;
};

export type AnalyticsInvoice = {
  org_id: string;
  status: string;
  kind: string;
  amount_gbp: number;
  paid_at: string | null;
  failed_at: string | null;
  due_date: string | null;
  created_at: string;
};

export type AnalyticsSnapshot = {
  orgs: ReadonlyArray<AnalyticsOrg>;
  invoices: ReadonlyArray<AnalyticsInvoice>;
  /** 12-month series reused from the existing HQ overview snapshot. */
  series: HqSnapshot["series"];
  generatedAt: string;
};

// ---------------------------------------------------------------------
// Revenue analytics
// ---------------------------------------------------------------------

export type RevenueAnalytics = {
  mrrGbp: number;
  arrGbp: number;
  /** Active customer growth % vs previous month (cumulative). */
  growthPct: number;
  /** Churn % over the last 30 days vs 30-day-ago active base. */
  churnPct: number;
  /** MRR forecast 90 days out — naive: current MRR × (1 + growthPct/100)^3. */
  forecast90dGbp: number;
  /** Average revenue per active customer = MRR / activeCustomers (or 0). */
  avgCustomerValueGbp: number;
  /** Sum of invoices in sent/failed today. */
  outstandingGbp: number;
  paidGbp: number;
  /** Refunded + void invoices summed. */
  lostRevenueGbp: number;
  /** Total billed revenue YTD (sum of paid invoices created this calendar year). */
  ytdRevenueGbp: number;
  series: HqSnapshot["series"];
};

export function computeRevenueAnalytics(
  snap: AnalyticsSnapshot,
): RevenueAnalytics {
  const active = snap.orgs.filter((o) => o.status === "active");
  const trial = snap.orgs.filter((o) => o.status === "trial");
  const mrrGbp = sumOf(active, (o) => o.mrr_gbp);
  const arrGbp = mrrGbp * 12;

  const growthPct = pctChangeLast(snap.series.customerGrowth);
  const churnPct = churnLast30Days(snap.orgs);

  // Compound the monthly growth rate three months out. Cap the input
  // so a 999% spike doesn't blow the forecast up.
  const monthlyRate = clamp(growthPct / 100, -0.5, 0.5);
  const forecast90dGbp =
    Math.round(mrrGbp * Math.pow(1 + monthlyRate, 3) * 100) / 100;

  const avgCustomerValueGbp =
    active.length > 0 ? Math.round((mrrGbp / active.length) * 100) / 100 : 0;

  let outstandingGbp = 0;
  let paidGbp = 0;
  let lostRevenueGbp = 0;
  let ytdRevenueGbp = 0;
  const ytdYear = new Date(snap.generatedAt).getUTCFullYear();
  for (const inv of snap.invoices) {
    const amount = Number(inv.amount_gbp);
    if (!Number.isFinite(amount)) continue;
    if (inv.status === "sent" || inv.status === "failed") {
      outstandingGbp += amount;
    }
    if (inv.status === "paid") {
      paidGbp += amount;
      const paidYear = inv.paid_at
        ? new Date(inv.paid_at).getUTCFullYear()
        : NaN;
      if (paidYear === ytdYear) ytdRevenueGbp += amount;
    }
    if (inv.status === "refunded" || inv.status === "void") {
      lostRevenueGbp += amount;
    }
  }

  // Mark unused so the type narrows in tools that flag dead bindings.
  void trial;

  return {
    mrrGbp,
    arrGbp,
    growthPct,
    churnPct,
    forecast90dGbp,
    avgCustomerValueGbp,
    outstandingGbp: round2(outstandingGbp),
    paidGbp: round2(paidGbp),
    lostRevenueGbp: round2(lostRevenueGbp),
    ytdRevenueGbp: round2(ytdRevenueGbp),
    series: snap.series,
  };
}

// ---------------------------------------------------------------------
// Customer analytics
// ---------------------------------------------------------------------

export type CustomerAnalytics = {
  /** Healthy: health_score >= 70. */
  healthy: number;
  /** At risk: 40-69. */
  atRisk: number;
  /** Critical: < 40. */
  critical: number;
  /** Orgs whose health_score is null (never computed). */
  unscored: number;
  migration: {
    averagePct: number;
    /** Average days from approved → migration 100%, for completed orgs. */
    averageDaysToComplete: number | null;
    stalledCount: number;
    fastestDays: number | null;
    completedCount: number;
  };
  usage: {
    activeLast7Days: number;
    activeLast30Days: number;
    neverLoggedIn: number;
    /** Average days since last login (active + trial only). */
    averageDaysSinceLogin: number | null;
  };
};

export function computeCustomerAnalytics(
  snap: AnalyticsSnapshot,
): CustomerAnalytics {
  const payingOrTrial = snap.orgs.filter(
    (o) => o.status === "active" || o.status === "trial",
  );

  let healthy = 0;
  let atRisk = 0;
  let critical = 0;
  let unscored = 0;
  for (const o of payingOrTrial) {
    if (o.health_score === null) {
      unscored++;
      continue;
    }
    if (o.health_score >= 70) healthy++;
    else if (o.health_score >= 40) atRisk++;
    else critical++;
  }

  const migrationPercents = payingOrTrial.map((o) => o.migration_percent);
  const averagePct =
    migrationPercents.length > 0
      ? Math.round(
          (migrationPercents.reduce((a, b) => a + b, 0) /
            migrationPercents.length) *
            10,
        ) / 10
      : 0;

  const completed = payingOrTrial.filter(
    (o) => o.migration_percent >= 100 && o.migration_days !== null,
  );
  const averageDaysToComplete =
    completed.length > 0
      ? Math.round(
          (completed.reduce((a, b) => a + (b.migration_days ?? 0), 0) /
            completed.length) *
            10,
        ) / 10
      : null;
  const fastestDays =
    completed.length > 0
      ? Math.min(...completed.map((c) => c.migration_days ?? Infinity))
      : null;

  const stalledCount = payingOrTrial.filter(
    (o) => o.migration_percent < 100 && (o.migration_days ?? 0) > 7,
  ).length;

  const now = new Date(snap.generatedAt).getTime();
  const activeLast7Days = payingOrTrial.filter((o) =>
    isWithinDays(o.last_login_at, now, 7),
  ).length;
  const activeLast30Days = payingOrTrial.filter((o) =>
    isWithinDays(o.last_login_at, now, 30),
  ).length;
  const neverLoggedIn = payingOrTrial.filter((o) => !o.last_login_at).length;

  const loginDays = payingOrTrial
    .filter((o) => o.last_login_at)
    .map((o) => Math.floor((now - new Date(o.last_login_at!).getTime()) / 86_400_000));
  const averageDaysSinceLogin =
    loginDays.length > 0
      ? Math.round((loginDays.reduce((a, b) => a + b, 0) / loginDays.length) * 10) /
        10
      : null;

  return {
    healthy,
    atRisk,
    critical,
    unscored,
    migration: {
      averagePct,
      averageDaysToComplete,
      stalledCount,
      fastestDays: fastestDays === Infinity ? null : fastestDays,
      completedCount: completed.length,
    },
    usage: {
      activeLast7Days,
      activeLast30Days,
      neverLoggedIn,
      averageDaysSinceLogin,
    },
  };
}

// ---------------------------------------------------------------------
// Benchmarking
// ---------------------------------------------------------------------

export type Benchmarks = {
  averageHealth: number | null;
  averageMrrGbp: number;
  averageLtvGbp: number;
  averageMigrationDays: number | null;
  /** Top 5 customers by MRR (paying-or-trial only). */
  topByMrr: ReadonlyArray<{
    id: string;
    name: string;
    mrr: number;
    health: number | null;
  }>;
  /** Top 5 customers by LTV (paying-or-trial only). */
  topByLtv: ReadonlyArray<{
    id: string;
    name: string;
    ltv: number;
    health: number | null;
  }>;
  /** Top 5 customers by health (paying-or-trial only). Filters out null. */
  topByHealth: ReadonlyArray<{
    id: string;
    name: string;
    health: number;
    mrr: number;
  }>;
};

export function computeBenchmarks(snap: AnalyticsSnapshot): Benchmarks {
  const payingOrTrial = snap.orgs.filter(
    (o) => o.status === "active" || o.status === "trial",
  );

  const healthScores = payingOrTrial
    .map((o) => o.health_score)
    .filter((s): s is number => s !== null);
  const averageHealth =
    healthScores.length > 0
      ? Math.round(
          (healthScores.reduce((a, b) => a + b, 0) / healthScores.length) * 10,
        ) / 10
      : null;

  const averageMrrGbp =
    payingOrTrial.length > 0
      ? round2(sumOf(payingOrTrial, (o) => o.mrr_gbp) / payingOrTrial.length)
      : 0;
  const averageLtvGbp =
    payingOrTrial.length > 0
      ? round2(sumOf(payingOrTrial, (o) => o.ltv_gbp) / payingOrTrial.length)
      : 0;

  const completed = payingOrTrial.filter(
    (o) => o.migration_days !== null && o.migration_percent >= 100,
  );
  const averageMigrationDays =
    completed.length > 0
      ? round2(
          completed.reduce((a, b) => a + (b.migration_days ?? 0), 0) /
            completed.length,
        )
      : null;

  const topByMrr = [...payingOrTrial]
    .sort((a, b) => b.mrr_gbp - a.mrr_gbp)
    .slice(0, 5)
    .map((o) => ({
      id: o.id,
      name: o.name,
      mrr: o.mrr_gbp,
      health: o.health_score,
    }));

  const topByLtv = [...payingOrTrial]
    .sort((a, b) => b.ltv_gbp - a.ltv_gbp)
    .slice(0, 5)
    .map((o) => ({
      id: o.id,
      name: o.name,
      ltv: o.ltv_gbp,
      health: o.health_score,
    }));

  const topByHealth = payingOrTrial
    .filter((o) => o.health_score !== null)
    .sort((a, b) => (b.health_score ?? 0) - (a.health_score ?? 0))
    .slice(0, 5)
    .map((o) => ({
      id: o.id,
      name: o.name,
      health: o.health_score as number,
      mrr: o.mrr_gbp,
    }));

  return {
    averageHealth,
    averageMrrGbp,
    averageLtvGbp,
    averageMigrationDays,
    topByMrr,
    topByLtv,
    topByHealth,
  };
}

// ---------------------------------------------------------------------
// AI COO insights panel — deterministic only
// ---------------------------------------------------------------------

export type Insight = {
  id: string;
  kind: "positive" | "neutral" | "negative";
  headline: string;
  detail: string;
};

/**
 * Generate the bullet-list of insights the analytics page shows in
 * its "AI COO insights" panel. Pure rules over the analytics
 * snapshot — no LLM. Each insight has a stable id so the same data
 * yields the same bullets across re-renders.
 */
export function buildInsightsPanel(
  rev: RevenueAnalytics,
  cust: CustomerAnalytics,
  bench: Benchmarks,
  highestRiskCustomerIds: ReadonlyArray<{ id: string; name: string }>,
): Insight[] {
  const out: Insight[] = [];

  // Revenue trend.
  if (rev.growthPct > 0) {
    out.push({
      id: "growth_up",
      kind: "positive",
      headline: `Revenue up ${rev.growthPct.toFixed(1)}% MoM`,
      detail: `Active customer base grew ${rev.growthPct.toFixed(1)}% vs last month. MRR now £${rev.mrrGbp.toLocaleString("en-GB")}.`,
    });
  } else if (rev.growthPct < 0) {
    out.push({
      id: "growth_down",
      kind: "negative",
      headline: `Revenue down ${Math.abs(rev.growthPct).toFixed(1)}% MoM`,
      detail: `Active customer base shrank by ${Math.abs(rev.growthPct).toFixed(1)}% — investigate cancellations.`,
    });
  }

  // Churn signal.
  if (rev.churnPct > 5) {
    out.push({
      id: "churn_risk",
      kind: "negative",
      headline: `Churn risk increased — ${rev.churnPct.toFixed(1)}% in 30d`,
      detail: `Churn jumped above the 5% guardrail. Schedule retention calls with at-risk customers.`,
    });
  }

  // Highest-risk customers.
  if (highestRiskCustomerIds.length > 0) {
    const names = highestRiskCustomerIds.slice(0, 3).map((c) => c.name).join(", ");
    out.push({
      id: "highest_risk_customers",
      kind: "negative",
      headline: `${highestRiskCustomerIds.length} highest-risk customers`,
      detail: `Health below 40: ${names}.`,
    });
  }

  // Outstanding invoices.
  if (rev.outstandingGbp > 0) {
    out.push({
      id: "outstanding_invoices",
      kind: rev.outstandingGbp > 5000 ? "negative" : "neutral",
      headline: `Outstanding invoices = £${rev.outstandingGbp.toLocaleString("en-GB")}`,
      detail:
        rev.outstandingGbp > 5000
          ? "Outstanding balance exceeds £5,000 — chase priority invoices."
          : "Manageable — keep an eye on the chase queue.",
    });
  }

  // Migration health.
  if (cust.migration.stalledCount > 0) {
    out.push({
      id: "stalled_migrations",
      kind: "negative",
      headline: `${cust.migration.stalledCount} stalled migrations`,
      detail: `Customers with no migration activity in 7+ days. Reach out to unblock.`,
    });
  }

  // Top performer callout.
  if (bench.topByMrr.length > 0) {
    const top = bench.topByMrr[0]!;
    out.push({
      id: "top_performer",
      kind: "positive",
      headline: `Top performer: ${top.name}`,
      detail: `£${top.mrr.toLocaleString("en-GB")} MRR · health ${top.health ?? "—"}.`,
    });
  }

  // Average health benchmark.
  if (bench.averageHealth !== null) {
    out.push({
      id: "average_health",
      kind:
        bench.averageHealth >= 70
          ? "positive"
          : bench.averageHealth >= 50
            ? "neutral"
            : "negative",
      headline: `Average customer health = ${bench.averageHealth}/100`,
      detail:
        bench.averageHealth < 50
          ? "Portfolio average is in the at-risk band — prioritise retention this week."
          : `Portfolio sits in the ${bench.averageHealth >= 70 ? "healthy" : "watch"} band.`,
    });
  }

  return out;
}

// ---------------------------------------------------------------------
// Helpers (pure, internal)
// ---------------------------------------------------------------------

function pctChangeLast(
  series: ReadonlyArray<{ count: number }>,
): number {
  if (series.length < 2) {
    return series.length > 0 && (series[series.length - 1]?.count ?? 0) > 0
      ? 100
      : 0;
  }
  // Cumulative customers.
  let cumulative = 0;
  const cum: number[] = [];
  for (const s of series) {
    cumulative += s.count;
    cum.push(cumulative);
  }
  const last = cum[cum.length - 1] ?? 0;
  const prev = cum[cum.length - 2] ?? 0;
  if (prev === 0) return last > 0 ? 100 : 0;
  const pct = ((last - prev) / prev) * 100;
  if (pct > 999) return 999;
  if (pct < -999) return -999;
  return Math.round(pct * 10) / 10;
}

function churnLast30Days(orgs: ReadonlyArray<AnalyticsOrg>): number {
  const now = Date.now();
  const since = now - 30 * 86_400_000;
  const recentlyCancelled = orgs.filter(
    (o) =>
      o.cancelled_at &&
      new Date(o.cancelled_at).getTime() >= since &&
      new Date(o.cancelled_at).getTime() <= now,
  ).length;

  // Active 30 days ago — approved on or before that date, not yet
  // cancelled at that date.
  const baseActive = orgs.filter((o) => {
    if (!o.approved_at) return false;
    const approved = new Date(o.approved_at).getTime();
    if (approved > since) return false;
    if (o.cancelled_at) {
      const cancelled = new Date(o.cancelled_at).getTime();
      if (cancelled < since) return false;
    }
    return true;
  }).length;

  if (baseActive === 0) return 0;
  const pct = (recentlyCancelled / baseActive) * 100;
  return Math.round(pct * 10) / 10;
}

function sumOf<T>(rows: ReadonlyArray<T>, get: (r: T) => number): number {
  let total = 0;
  for (const r of rows) {
    const v = get(r);
    if (Number.isFinite(v)) total += v;
  }
  return total;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(n: number, min: number, max: number): number {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function isWithinDays(iso: string | null, now: number, days: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return false;
  return now - t <= days * 86_400_000;
}

// ---------------------------------------------------------------------
// CSV serialisation
// ---------------------------------------------------------------------

export function analyticsToCsv(
  rev: RevenueAnalytics,
  cust: CustomerAnalytics,
  bench: Benchmarks,
): string {
  const rows: ReadonlyArray<[string, string]> = [
    ["Section", "Metric"],
    ["Revenue", "MRR"],
    ["Revenue", "ARR"],
    ["Revenue", "Growth % MoM"],
    ["Revenue", "Churn % 30d"],
    ["Revenue", "Forecast 90d MRR"],
    ["Revenue", "Avg customer value"],
    ["Revenue", "Outstanding"],
    ["Revenue", "Paid"],
    ["Revenue", "Lost revenue"],
    ["Revenue", "YTD revenue"],
    ["Customers", "Healthy"],
    ["Customers", "At risk"],
    ["Customers", "Critical"],
    ["Customers", "Unscored"],
    ["Migration", "Average %"],
    ["Migration", "Avg days to complete"],
    ["Migration", "Stalled count"],
    ["Migration", "Fastest days"],
    ["Migration", "Completed count"],
    ["Usage", "Active last 7d"],
    ["Usage", "Active last 30d"],
    ["Usage", "Never logged in"],
    ["Usage", "Avg days since login"],
    ["Benchmark", "Average health"],
    ["Benchmark", "Average MRR"],
    ["Benchmark", "Average LTV"],
    ["Benchmark", "Average migration days"],
  ];

  const values: Record<string, number | string | null> = {
    "Revenue/MRR": rev.mrrGbp,
    "Revenue/ARR": rev.arrGbp,
    "Revenue/Growth % MoM": rev.growthPct,
    "Revenue/Churn % 30d": rev.churnPct,
    "Revenue/Forecast 90d MRR": rev.forecast90dGbp,
    "Revenue/Avg customer value": rev.avgCustomerValueGbp,
    "Revenue/Outstanding": rev.outstandingGbp,
    "Revenue/Paid": rev.paidGbp,
    "Revenue/Lost revenue": rev.lostRevenueGbp,
    "Revenue/YTD revenue": rev.ytdRevenueGbp,
    "Customers/Healthy": cust.healthy,
    "Customers/At risk": cust.atRisk,
    "Customers/Critical": cust.critical,
    "Customers/Unscored": cust.unscored,
    "Migration/Average %": cust.migration.averagePct,
    "Migration/Avg days to complete": cust.migration.averageDaysToComplete,
    "Migration/Stalled count": cust.migration.stalledCount,
    "Migration/Fastest days": cust.migration.fastestDays,
    "Migration/Completed count": cust.migration.completedCount,
    "Usage/Active last 7d": cust.usage.activeLast7Days,
    "Usage/Active last 30d": cust.usage.activeLast30Days,
    "Usage/Never logged in": cust.usage.neverLoggedIn,
    "Usage/Avg days since login": cust.usage.averageDaysSinceLogin,
    "Benchmark/Average health": bench.averageHealth,
    "Benchmark/Average MRR": bench.averageMrrGbp,
    "Benchmark/Average LTV": bench.averageLtvGbp,
    "Benchmark/Average migration days": bench.averageMigrationDays,
  };

  const header = ["Section", "Metric", "Value"].map(csvEscape).join(",");
  const body = rows
    .slice(1)
    .map((row) => {
      const [section, metric] = row;
      const key = `${section}/${metric}`;
      const value = values[key] ?? "";
      return [section, metric, value].map(csvEscape).join(",");
    })
    .join("\n");
  return `${header}\n${body}\n`;
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (s.includes(",") || s.includes("\n") || s.includes('"')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ---------------------------------------------------------------------
// Re-exports used by the page
// ---------------------------------------------------------------------

export { MONTHLY_PRICE_GBP };
