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

export function marginBand(marginPct: number | null): MarginBand {
  if (marginPct === null || !Number.isFinite(marginPct)) return "neutral";
  if (marginPct > 30) return "green";
  if (marginPct >= 15) return "amber";
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

type InvoiceRow = { job_id: string | null; amount: number | string | null };
type FinanceRow = {
  job_id: string | null;
  amount: number | string | null;
  category: string | null;
};

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
    if (inv.job_id === jobId) revenue += Number(inv.amount ?? 0);
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
  invoices: Array<{ amount: number | string | null; created_at?: string | null; paid_at?: string | null }>,
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
    if (bucket) bucket.revenue += Number(inv.amount ?? 0);
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
  invoices: Array<{ amount: number | string | null; created_at?: string | null }>,
  finances: Array<{ amount: number | string | null; created_at?: string | null }>,
  now: Date = new Date(),
): number {
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  let rev = 0;
  let cost = 0;
  for (const inv of invoices) {
    if (inv.created_at && inv.created_at.slice(0, 7) === monthKey) {
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
