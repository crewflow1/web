/**
 * Job profitability helpers — pure functions, server/client-safe.
 *
 * Revenue per job = sum of invoices.amount (excl VAT) linked via job_id.
 * Costs per job   = sum of finances.amount (excl VAT) linked via job_id.
 * Gross profit    = revenue - costs
 * Margin %        = profit / revenue × 100  (null when revenue == 0)
 *
 * Why excl VAT on both sides: VAT is reclaimable / collected on behalf
 * of HMRC, not income or cost. Net P&L is the standard.
 */

/** The 4 profitability buckets the CEO asked for. */
export type CostBucket = "labour" | "materials" | "subcontractors" | "misc";

export const COST_BUCKETS: readonly CostBucket[] = [
  "labour",
  "materials",
  "subcontractors",
  "misc",
] as const;

/**
 * Map the existing free-text finance.category values (8 of them) onto
 * the 4 profitability buckets. Anything unknown falls to "misc".
 */
export function mapToCostBucket(category: string | null | undefined): CostBucket {
  if (!category) return "misc";
  const c = category.trim().toLowerCase();
  if (c === "labour" || c === "labor") return "labour";
  if (c === "materials") return "materials";
  if (c === "subcontractor" || c === "subcontractors") return "subcontractors";
  return "misc";
}

/**
 * Margin colour bands per the CEO spec:
 *   green   > 30 %
 *   amber   15 – 30 %  (inclusive of 15, exclusive of upper to give clean handover)
 *   red     < 15 %
 *   neutral when revenue is zero (no work to assess yet)
 */
export type MarginBand = "green" | "amber" | "red" | "neutral";

/**
 * The org-wide fallback target. 30 % was always a UNIVERSAL assumption — the
 * only one available while no job carried a cost baseline to compare against
 * (see supabase/migrations/20261072000000_job_cost_baseline.sql). A
 * groundworks job and a bathroom refit do not share a target margin, and
 * telling both of them "red" at 14 % is the same as telling neither anything.
 */
export const UNIVERSAL_TARGET_MARGIN_PCT = 30;

/**
 * Band a margin, PREFERRING a per-job target when the job has one.
 *
 * With target T the bands generalise the published spec exactly:
 *   green   margin >  T
 *   amber   margin >= T / 2
 *   red     below that
 *
 * At T = 30 that is 30 / 15 — byte-for-byte today's behaviour, which is why
 * `marginBand(m)` and `marginBand(m, 30)` are the same function and a job with
 * NO budget is unaffected (both paths are pinned in
 * __tests__/profitability/compute.test.ts). T/2 rather than a fixed 15 because
 * the amber floor has to move with the target: a 12 % target with a 15 % amber
 * floor would paint an ON-PLAN job red.
 *
 * A negative or non-finite target is ignored (fallback). Zero is honoured — "we
 * are happy to break even on this one" is a real instruction, and it makes any
 * profit green.
 */
export function marginBand(
  marginPct: number | null,
  targetPct?: number | null,
): MarginBand {
  if (marginPct === null || !Number.isFinite(marginPct)) return "neutral";
  const target =
    targetPct == null || !Number.isFinite(targetPct) || targetPct < 0
      ? UNIVERSAL_TARGET_MARGIN_PCT
      : targetPct;
  if (marginPct > target) return "green";
  if (marginPct >= target / 2) return "amber";
  return "red";
}

/** Tailwind classes for a margin pill / tile background. */
export function marginPillClass(band: MarginBand): string {
  switch (band) {
    case "green":
      return "bg-green-100 text-green-800 border-green-200";
    case "amber":
      return "bg-amber-100 text-amber-800 border-amber-200";
    case "red":
      return "bg-red-100 text-red-800 border-red-200";
    default:
      return "bg-slate-100 text-slate-700 border-slate-200";
  }
}

export type JobProfitability = {
  job_id: string;
  revenue: number;
  costs_total: number;
  costs_by_bucket: Record<CostBucket, number>;
  gross_profit: number;
  margin_pct: number | null;
  band: MarginBand;
};

type InvoiceRow = {
  job_id: string | null;
  amount: number | string | null;
  /**
   * Optional: when the feeder selects it, a `void` invoice (20261219 — the
   * operational correction state) is excluded from revenue here as well.
   * Feeders pass `status` through so this filter bites (the portal list and
   * accounting export additionally filter at the query); a voided £50k mistake
   * must never linger as phantom job revenue.
   */
  status?: string | null;
};

/** A voided invoice is not revenue on any profit surface. */
function isRevenueRow(inv: { status?: string | null }): boolean {
  return inv.status !== "void";
}
type FinanceRow = {
  job_id: string | null;
  amount: number | string | null;
  category: string | null;
};

/**
 * Time-entry shape consumed for labour cost. Hours can be precomputed by
 * the caller (via `lib/time/compute.hoursByJob`) — we keep this loosely
 * shaped so callers can also pass raw entries with hours field.
 */
export type LabourEntry = {
  job_id: string | null;
  user_id: string;
  hours: number;
};

/**
 * Convert time_entries + per-user hourly rates into the same shape as
 * `finances` rows so they slot into the existing labour bucket. Anything
 * with no hourly_pay falls to 0 — owners get warned about missing rates
 * on the staff page.
 */
export function labourCostsFromTimeEntries(
  entries: LabourEntry[],
  hourlyRateByUser: Map<string, number>,
): FinanceRow[] {
  const out: FinanceRow[] = [];
  for (const e of entries) {
    if (!e.job_id) continue;
    const rate = hourlyRateByUser.get(e.user_id) ?? 0;
    if (e.hours <= 0 || rate <= 0) continue;
    out.push({
      job_id: e.job_id,
      amount: Math.round(e.hours * rate * 100) / 100,
      category: "labour",
    });
  }
  return out;
}

/**
 * Compute profitability for a single job. Returns null when no invoice
 * AND no finance is linked (no data → not meaningful).
 */
export function computeJobProfitability(
  jobId: string,
  invoices: InvoiceRow[],
  finances: FinanceRow[],
): JobProfitability | null {
  let revenue = 0;
  for (const inv of invoices) {
    if (inv.job_id === jobId && isRevenueRow(inv)) revenue += Number(inv.amount ?? 0);
  }
  const buckets: Record<CostBucket, number> = {
    labour: 0,
    materials: 0,
    subcontractors: 0,
    misc: 0,
  };
  let costs_total = 0;
  for (const f of finances) {
    if (f.job_id !== jobId) continue;
    const amt = Number(f.amount ?? 0);
    costs_total += amt;
    buckets[mapToCostBucket(f.category)] += amt;
  }
  if (revenue === 0 && costs_total === 0) return null;
  const gross_profit = revenue - costs_total;
  const margin_pct = revenue === 0 ? null : Math.round((gross_profit / revenue) * 100);
  return {
    job_id: jobId,
    revenue,
    costs_total,
    costs_by_bucket: buckets,
    gross_profit,
    margin_pct,
    band: marginBand(margin_pct),
  };
}

/**
 * Roll-up across all jobs in the data set. Returns one row per job that
 * has either revenue or cost.
 */
export function computeAllJobsProfitability(
  jobs: Array<{ id: string }>,
  invoices: InvoiceRow[],
  finances: FinanceRow[],
): JobProfitability[] {
  const out: JobProfitability[] = [];
  for (const j of jobs) {
    const p = computeJobProfitability(j.id, invoices, finances);
    if (p) out.push(p);
  }
  return out;
}

/** Top N by absolute gross_profit (largest money-makers). */
export function topProfitableJobs(rows: JobProfitability[], n = 5): JobProfitability[] {
  return [...rows].sort((a, b) => b.gross_profit - a.gross_profit).slice(0, n);
}

/**
 * Bottom N by margin % (worst-margin first). Jobs with null margin
 * (no revenue) are excluded — they're not legible losses yet.
 */
export function worstJobs(rows: JobProfitability[], n = 5): JobProfitability[] {
  return [...rows]
    .filter((r) => r.margin_pct !== null)
    .sort((a, b) => (a.margin_pct ?? 0) - (b.margin_pct ?? 0))
    .slice(0, n);
}

/** Org-wide average margin across jobs that have revenue. */
export function averageMargin(rows: JobProfitability[]): number | null {
  const withRevenue = rows.filter((r) => r.margin_pct !== null);
  if (withRevenue.length === 0) return null;
  const sum = withRevenue.reduce((s, r) => s + (r.margin_pct ?? 0), 0);
  return Math.round(sum / withRevenue.length);
}

/**
 * Monthly profit series for the last `months` buckets, including the
 * current month. Aggregates ALL invoices and finances org-wide, not
 * per-job — useful for the "Profit by month" + "Revenue vs cost"
 * dashboard charts.
 */
export type MonthBucket = {
  month: string; // YYYY-MM
  revenue: number;
  costs: number;
  profit: number;
};

export function profitByMonth(
  invoices: Array<{
    amount: number | string | null;
    created_at?: string | null;
    paid_at?: string | null;
    /** When present, `void` rows (20261219) are excluded from revenue. */
    status?: string | null;
  }>,
  finances: Array<{ amount: number | string | null; created_at?: string | null }>,
  months: number,
  /** Use 'paid_at' to count revenue only when paid; 'created_at' to count when issued. */
  invoiceDateField: "created_at" | "paid_at" = "created_at",
  now: Date = new Date(),
): MonthBucket[] {
  const buckets = new Map<string, MonthBucket>();
  // Pre-fill months so empty months still render in the chart. Build
  // dates in UTC to avoid local-time slips landing on the previous
  // month (e.g. a host on BST sees `new Date(2026, 4, 1)` as
  // 2026-04-30T23:00:00Z under getUTCMonth, dropping a bucket).
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    buckets.set(key, { month: key, revenue: 0, costs: 0, profit: 0 });
  }
  const earliestKey = buckets.keys().next().value;

  for (const inv of invoices) {
    const dateStr = inv[invoiceDateField];
    if (!dateStr) continue;
    const key = dateStr.slice(0, 7);
    if (!earliestKey || key < earliestKey) continue;
    const bucket = buckets.get(key);
    if (bucket && isRevenueRow(inv)) bucket.revenue += Number(inv.amount ?? 0);
  }
  for (const f of finances) {
    if (!f.created_at) continue;
    const key = f.created_at.slice(0, 7);
    if (!earliestKey || key < earliestKey) continue;
    const bucket = buckets.get(key);
    if (bucket) bucket.costs += Number(f.amount ?? 0);
  }
  for (const b of buckets.values()) b.profit = b.revenue - b.costs;
  return Array.from(buckets.values());
}

/** Sum of profit across the data set (for a "Total profit, month" tile). */
export function totalProfitThisMonth(
  invoices: Array<{
    amount: number | string | null;
    created_at?: string | null;
    /** When present, `void` rows (20261219) are excluded from revenue. */
    status?: string | null;
  }>,
  finances: Array<{ amount: number | string | null; created_at?: string | null }>,
  now: Date = new Date(),
): number {
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  let rev = 0;
  let cost = 0;
  for (const inv of invoices) {
    if (inv.created_at && inv.created_at.slice(0, 7) === monthKey && isRevenueRow(inv)) {
      rev += Number(inv.amount ?? 0);
    }
  }
  for (const f of finances) {
    if (f.created_at && f.created_at.slice(0, 7) === monthKey) {
      cost += Number(f.amount ?? 0);
    }
  }
  return rev - cost;
}
