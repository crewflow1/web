/**
 * CrewFlow HQ — pure metrics compute.
 *
 * Server/client-safe — no Supabase imports. The server-only snapshot
 * lives in `server/services/hq-snapshot.ts`. Tests exercise this
 * module directly with synthetic snapshots.
 *
 * Business model (CEO directive):
 *   - £1,000 one-off setup fee per customer
 *   - £500/month per active or trial customer
 *   - No automation yet — we just MEASURE; status tracking only.
 */

import {
  formatGbp,
  MONTHLY_PRICE_GBP,
  SETUP_FEE_GBP,
} from "@/lib/hq/customer-financials";

// Pricing lives once in customer-financials; re-exported so existing
// `@/lib/hq/metrics` importers (the snapshot, analytics) keep their path.
export { MONTHLY_PRICE_GBP, SETUP_FEE_GBP };

/** Raw counts pulled from the DB by `buildHqSnapshot`. */
export type HqSnapshot = {
  /** Demo requests grouped by lifecycle status. */
  demos: {
    pending_demo: number;
    demo_booked: number;
    approved: number;
    rejected: number;
    cancelled: number;
    legacy_new: number;
  };
  /** Organisations grouped by status. */
  orgs: {
    pending: number;
    trial: number;
    active: number;
    suspended: number;
    rejected: number;
    cancelled: number;
  };
  /** Setup-fee status — until billing schema lands, every active customer is assumed paid. */
  setupFees: {
    paid_orgs: number;
    pending_orgs: number;
  };
  /** Time series for the last 12 months (oldest → newest). */
  series: {
    /** New orgs flipped to active or trial in each month. */
    customerGrowth: ReadonlyArray<{ month: string; count: number }>;
    /** MRR snapshot at end of each month — sum of (active + trial) × £500 of orgs created on/before that month-end. */
    mrr: ReadonlyArray<{ month: string; mrr: number }>;
    /** Orgs cancelled in each month. */
    cancellation: ReadonlyArray<{ month: string; count: number }>;
    /** Total billed revenue per month (setup-fee one-offs + MRR). */
    revenue: ReadonlyArray<{ month: string; revenue: number }>;
  };
  /** Generated timestamp, in case the panel needs to show "as of …". */
  generatedAt: string;
};

export type HqMetrics = {
  /** Current monthly recurring revenue — (active + trial) × £500. */
  mrrGbp: number;
  /** Cumulative setup fees recognised so far. */
  setupFeesEarnedGbp: number;
  activeCustomers: number;
  activeOnboarding: number;
  pendingDemos: number;
  cancelledCustomers: number;
  /** MRR + projected upgrades from current trials. */
  forecastMrrGbp: number;
  /** Active customer growth % vs 30 days ago. Capped/floored at ±999%. */
  growthPct: number;
};

/**
 * Compute the headline KPI tiles from a snapshot.
 */
export function computeMetrics(snap: HqSnapshot): HqMetrics {
  const active = snap.orgs.active;
  const trial = snap.orgs.trial;
  const mrrGbp = active * MONTHLY_PRICE_GBP;
  const forecastMrrGbp = (active + trial) * MONTHLY_PRICE_GBP;

  // Setup fees: every paid org has crossed the setup threshold.
  // Until /admin/billing lands the explicit flag, treat every
  // active/trial org as setup-paid (the conservative direction —
  // mismatch would over-report so we'll tighten in HQ-4).
  const setupFeesEarnedGbp = snap.setupFees.paid_orgs * SETUP_FEE_GBP;

  // Growth: count active+trial orgs vs the count 30 days ago.
  // Derive from the customerGrowth series: cumulative customers at
  // each month is total active+trial created so far.
  const cumulative = cumulativeFromGrowth(snap.series.customerGrowth);
  const last = cumulative.length > 0 ? cumulative[cumulative.length - 1] ?? 0 : 0;
  // Compare against 1 entry back (last 30d).
  const prev = cumulative.length >= 2 ? cumulative[cumulative.length - 2] ?? 0 : 0;
  const growthPct = prev === 0
    ? last > 0
      ? 100
      : 0
    : clampPct(((last - prev) / prev) * 100);

  return {
    mrrGbp,
    setupFeesEarnedGbp,
    activeCustomers: active,
    activeOnboarding: trial,
    pendingDemos: snap.demos.pending_demo + snap.demos.legacy_new,
    cancelledCustomers: snap.orgs.cancelled,
    forecastMrrGbp,
    growthPct,
  };
}

/**
 * Morning summary string ready for the dashboard greeting card.
 *
 *   Good morning {firstName}
 *   New demos: 3 · Need contact: 2 · Migration: 4 · MRR: £4,500 · Forecast: £7,200
 */
export type MorningSummary = {
  greeting: string;
  bullets: ReadonlyArray<{ label: string; value: string }>;
};

export function buildMorningSummary(
  metrics: HqMetrics,
  firstName: string | null,
  now: Date = new Date(),
): MorningSummary {
  const greeting = greetingFor(firstName, now);
  return {
    greeting,
    bullets: [
      { label: "New demos awaiting contact", value: String(metrics.pendingDemos) },
      { label: "Customers in onboarding/trial", value: String(metrics.activeOnboarding) },
      { label: "Active paying customers", value: String(metrics.activeCustomers) },
      { label: "MRR right now", value: formatGbp(metrics.mrrGbp) },
      { label: "Forecast MRR (incl. trials)", value: formatGbp(metrics.forecastMrrGbp) },
    ],
  };
}

function greetingFor(firstName: string | null, now: Date): string {
  const hour = now.getHours();
  const period =
    hour < 5 ? "Up late," : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  return firstName ? `${period} ${firstName}.` : `${period}.`;
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n > 999) return 999;
  if (n < -999) return -999;
  return Math.round(n * 10) / 10;
}

function cumulativeFromGrowth(
  series: ReadonlyArray<{ month: string; count: number }>,
): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const row of series) {
    acc += row.count;
    out.push(acc);
  }
  return out;
}

/**
 * Generate evenly-spaced "YYYY-MM" buckets for the last `months`
 * months, ending on the bucket containing `anchor`. Used by the
 * snapshot service to align all the time series so they share an
 * X axis.
 */
export function monthBuckets(
  months: number,
  anchor: Date = new Date(),
): string[] {
  const out: string[] = [];
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(year, month - i, 1));
    out.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`,
    );
  }
  return out;
}

/**
 * SVG-friendly sparkline point list. The component renders these as a
 * polyline — no chart library, no client-side dependency.
 */
export function sparklinePoints(
  series: ReadonlyArray<{ month: string; count?: number; mrr?: number; revenue?: number }>,
  field: "count" | "mrr" | "revenue",
  width: number,
  height: number,
): { d: string; max: number; min: number } {
  if (series.length === 0) return { d: "", max: 0, min: 0 };
  const values = series.map((r) => r[field] ?? 0);
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const step = series.length > 1 ? width / (series.length - 1) : width;
  const pts = values.map((v, i) => {
    const x = i * step;
    const y = height - ((v - min) / range) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return { d: `M ${pts.join(" L ")}`, max, min };
}
