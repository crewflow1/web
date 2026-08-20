/**
 * Job-cost input builder — the SINGLE source of truth for what a job's "actual
 * cost" is made of.
 *
 * A job's true cost is NOT just its `finances` rows. It also includes:
 *   1. time-tracked labour (gross pay = hours × hourly_pay),
 *   2. employer on-costs on that labour (employer NI + employer pension), and
 *   3. the weighted-average COGS of stock ISSUED to the job from inventory.
 *
 * (1) and (2) are emitted as extra finance-row-shaped entries tagged
 * `category: "labour"` so `computeJobProfitability` / `computeAllJobsProfitability`
 * pick them up under the labour bucket with no bespoke wiring:
 *
 *     computeJobProfitability(jobId, invoices, buildJobCostInput({ ... }))
 *
 * Before this builder existed, the dashboard composed `[...finances, ...labourRows,
 * ...employerOnCostRows]` inline while the per-job commercial surfaces passed
 * `finances` ALONE — so every job with clocked labour looked more profitable on its
 * own page than on the dashboard. Centralising the composition here means the two
 * can no longer diverge.
 *
 * ── (3) STOCK COGS — THE THIRD STREAM, AND WHY IT DOES NOT DOUBLE-COUNT ──────
 * Stock issued from inventory to a job is a REAL material cost of that job, but it
 * is NOT in the job's `finances` rows: `lib/stock` posts NOTHING to `finances`
 * (asserted on source by the operational-stock security test and the
 * 20261180000000 migration header) — a purchase is expensed exactly once, by
 * `recordSupplierBill`, when the supplier's bill is recorded, booked to the DEPOT
 * (`finances.job_id` null). So before this stream existed, a job's margin
 * UNDERSTATED its cost by the whole COGS of the stock it consumed.
 *
 * The stock-COGS rows (from `lib/stock/valuation.buildStockCogsCostRows`) are the
 * weighted-average value RELEASED to the job on issue, tagged `category:
 * "materials"`, so they land in the materials bucket exactly as labour lands in
 * labour. They are an ALLOCATION of depot-replenishment spend onto the consuming
 * job — never a new expense — so the company-level P&L is byte-identical with or
 * without them, and NO amount is counted twice. That last claim is an INVARIANT,
 * not a hope: a material cost reaches a job's margin through EITHER a direct
 * `finances` materials bill (from a job-tagged PO) OR a stock issue (goods from
 * the job-less depot pool), never both for one spend — because
 * `record_stock_receipt_from_grn` REFUSES to stock a delivery whose PO carries a
 * `job_id` (migration 20261212000000), so a job-tagged purchase can never also be
 * issued back to its job as COGS. Because the caller passes `stockCogs`
 * explicitly, the stream stays a deliberate, labelled composition (never
 * auto-merged) and remains separable and auditable.
 *
 * ── HOURS SCOPE IS THE CALLER'S CHOICE ─────────────────────────────────────
 * Employer NI is BANDED on a worker's whole-period earnings, so the caller decides
 * which hours belong in the period (`hoursForEntries`) and which payroll cycle bands
 * them (`cycle` / `periodStartIso`). Two legitimate scopes exist:
 *   - the DASHBOARD wants a MONTH window (its labour/margin tiles are "this month"),
 *     so it passes `windowHoursSource(monthStart, monthEnd)`;
 *   - a PER-JOB commercial view wants JOB-LIFETIME hours (a job, and its budget,
 *     span its whole life — a month window would silently drop earlier labour),
 *     so it passes `lifetimeHoursSource`.
 * The builder is parameterised by the hours source precisely so each surface passes
 * the scope that is correct for it, from one shared composition.
 */

import { entryHours, hoursInWindow, type TimeEntry } from "@/lib/time/compute";
import { labourCostsFromTimeEntries, type LabourEntry } from "@/lib/profitability/compute";
import { employerOnCostsFromTimeEntries } from "@/lib/payroll/compute";

/** Finance-row shape consumed by the profitability authority. */
export type CostInputRow = {
  job_id: string | null;
  amount: number | string | null;
  category: string | null;
};

/**
 * Measure the hours of a set of time entries for one (job, user) group. The two
 * ready-made sources below cover the two legitimate scopes; a caller can pass its
 * own if it needs a different window.
 */
export type HoursSource = (entries: TimeEntry[]) => number;

/** Month/week window scope (used by the dashboard). */
export function windowHoursSource(from: Date, to: Date, now?: Date): HoursSource {
  return (entries) => hoursInWindow(entries, from, to, now);
}

/**
 * Job-lifetime scope (used by the per-job commercial surfaces and the
 * job-budget / company-health rollups): every hour ever booked to the job,
 * regardless of month. `entryHours` counts an open entry up to `now`.
 */
export function lifetimeHoursSource(now?: Date): HoursSource {
  return (entries) => entries.reduce((sum, e) => sum + entryHours(e, now), 0);
}

/**
 * Group raw time entries into per-(job, user) hour slices, measuring hours with
 * the caller's chosen source. Entries with no `job_id` (overhead) and groups that
 * net to zero hours are dropped — they contribute no direct job cost.
 *
 * Grouping per (job, user) then measuring the group is equal to measuring each
 * entry alone and summing (hours are additive across entries), so this reproduces
 * the dashboard's original per-entry accumulation exactly.
 */
export function buildLabourSlices(
  timeEntries: TimeEntry[],
  hoursForEntries: HoursSource,
): LabourEntry[] {
  const byJob = new Map<string, Map<string, TimeEntry[]>>();
  for (const te of timeEntries) {
    if (!te.job_id) continue;
    let byUser = byJob.get(te.job_id);
    if (!byUser) {
      byUser = new Map();
      byJob.set(te.job_id, byUser);
    }
    const list = byUser.get(te.user_id);
    if (list) list.push(te);
    else byUser.set(te.user_id, [te]);
  }

  const slices: LabourEntry[] = [];
  for (const [jobId, byUser] of byJob) {
    for (const [userId, entries] of byUser) {
      const hours = hoursForEntries(entries);
      if (hours > 0) slices.push({ job_id: jobId, user_id: userId, hours });
    }
  }
  return slices;
}

export type JobCostInputParams = {
  /** The job's (or org's) `finances` rows — the non-labour cost. */
  finances: CostInputRow[];
  /** Raw `time_entries` — the labour spine. */
  timeEntries: TimeEntry[];
  /** Per-user hourly pay (from `memberships` → `users.hourly_pay`). */
  hourlyByUser: Map<string, number>;
  /** How to measure hours per (job, user) group — window vs job-lifetime. */
  hoursForEntries: HoursSource;
  /** Payroll cycle that bands employer NI on the measured hours. */
  cycle: "weekly" | "monthly";
  /** Period start, selecting the dated NI/pension rate table. Undefined = latest. */
  periodStartIso?: string;
  /**
   * Optional per-user annual salary sacrifice (£). Sacrifice is outside the employer
   * NI + pension base, so it lowers the on-cost for that worker. Absent ⇒ no
   * sacrifice, on-costs byte-identical to before.
   */
  sacrificeByUser?: Map<string, number>;
  /**
   * Optional weighted-average stock-COGS allocation rows — the value of stock
   * ISSUED to each job from inventory, from `buildStockCogsCostRows`. Already
   * finance-row-shaped (`category: "materials"`, positive amount, keyed by
   * job_id) and NET of corrections. Composed as a distinct, labelled stream —
   * see the "third stream" note above for why it never double-counts `finances`.
   * Absent ⇒ no stock COGS, cost input byte-identical to before.
   */
  stockCogs?: CostInputRow[];
};

/**
 * THE combined cost input:
 * `[...finances, ...labour, ...employerOnCosts, ...stockCogs]`.
 *
 * This is the one place the cost streams are joined. Feed the result to
 * `computeJobProfitability` / `computeAllJobsProfitability` unchanged. Each stream
 * is disjoint: `finances` (booked expenses), labour + on-costs (from time
 * entries), and stock COGS (value released on issue, never in `finances`) — so a
 * cost reaches a job's margin exactly once.
 */
export function buildJobCostInput(params: JobCostInputParams): CostInputRow[] {
  const slices = buildLabourSlices(params.timeEntries, params.hoursForEntries);
  const labourRows = labourCostsFromTimeEntries(slices, params.hourlyByUser);
  const employerOnCostRows = employerOnCostsFromTimeEntries(
    slices,
    params.hourlyByUser,
    params.cycle,
    params.periodStartIso,
    params.sacrificeByUser,
  );
  return [
    ...params.finances,
    ...labourRows,
    ...employerOnCostRows,
    ...(params.stockCogs ?? []),
  ];
}
