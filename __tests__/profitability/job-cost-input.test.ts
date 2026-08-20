import { describe, it, expect } from "vitest";
import {
  buildJobCostInput,
  buildLabourSlices,
  windowHoursSource,
  lifetimeHoursSource,
} from "@/lib/profitability/job-cost-input";
import { computeJobProfitability } from "@/lib/profitability/compute";
import {
  buildStockCogsCostRows,
  stockCogsByJob,
  type CostedMovementRow,
} from "@/lib/stock/valuation";
import type { TimeEntry } from "@/lib/time/compute";

/**
 * C29 job-cost parity: the per-job commercial surfaces and the dashboard both
 * compute actual cost / gross profit / margin from the SAME shared builder, so a
 * job with time-tracked labour can never again look more profitable on its own
 * page than on the dashboard. These tests pin that parity and the inclusion of
 * labour + employer on-costs.
 */

const JOB = "job-A";
const RATE = 40;
const hourly = new Map<string, number>([["u1", RATE]]);

/** A single synthetic entry spanning `hours` with no breaks. */
function entry(id: string, startIso: string, hours: number, jobId: string | null = JOB): TimeEntry {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + hours * 3_600_000);
  return {
    id,
    user_id: "u1",
    job_id: jobId,
    started_at: start.toISOString(),
    ended_at: end.toISOString(),
    breaks: [],
  };
}

// A big enough month of labour to clear the employer-NI secondary threshold, so
// employer on-costs are provably non-zero: 300h × £40 = £12,000 in one month.
const juneEntry = entry("te-june", "2026-06-02T00:00:00Z", 300);
const GROSS_LABOUR = 300 * RATE; // 12,000
const finances = [{ job_id: JOB, amount: 2000, category: "materials" }];
const invoices = [{ job_id: JOB, amount: 30000 }];

const monthStart = new Date("2026-06-01T00:00:00Z");
const monthEnd = new Date("2026-07-01T00:00:00Z");
const now = new Date("2026-06-30T00:00:00Z");

describe("buildJobCostInput — dashboard/per-job parity", () => {
  it("dashboard (window) and per-job (lifetime) agree when all labour is in the window", () => {
    // Same entry, both scopes — the window fully contains it, so the two hour
    // sources measure the same hours and the two cost inputs must be identical.
    const dashboardInput = buildJobCostInput({
      finances,
      timeEntries: [juneEntry],
      hourlyByUser: hourly,
      hoursForEntries: windowHoursSource(monthStart, monthEnd, now),
      cycle: "monthly",
      periodStartIso: "2026-06-01",
    });
    const commercialInput = buildJobCostInput({
      finances,
      timeEntries: [juneEntry],
      hourlyByUser: hourly,
      hoursForEntries: lifetimeHoursSource(now),
      cycle: "monthly",
      periodStartIso: "2026-06-01",
    });

    const dash = computeJobProfitability(JOB, invoices, dashboardInput);
    const comm = computeJobProfitability(JOB, invoices, commercialInput);

    expect(comm).not.toBeNull();
    expect(comm!.costs_total).toBe(dash!.costs_total);
    expect(comm!.gross_profit).toBe(dash!.gross_profit);
    expect(comm!.margin_pct).toBe(dash!.margin_pct);
    expect(comm!.costs_by_bucket.labour).toBe(dash!.costs_by_bucket.labour);
  });

  it("includes time-tracked labour AND employer on-costs (both non-zero)", () => {
    const input = buildJobCostInput({
      finances,
      timeEntries: [juneEntry],
      hourlyByUser: hourly,
      hoursForEntries: lifetimeHoursSource(now),
      cycle: "monthly",
      periodStartIso: "2026-06-01",
    });
    const withLabour = computeJobProfitability(JOB, invoices, input)!;

    // Labour bucket = gross pay + employer NI + pension. It must strictly exceed
    // gross pay alone — that gap IS the employer on-cost, and it must be present.
    expect(withLabour.costs_by_bucket.labour).toBeGreaterThan(GROSS_LABOUR);
    const employerOnCost = withLabour.costs_by_bucket.labour - GROSS_LABOUR;
    expect(employerOnCost).toBeGreaterThan(0);

    // Materials (finances) survive alongside labour.
    expect(withLabour.costs_by_bucket.materials).toBe(2000);
    expect(withLabour.costs_total).toBe(withLabour.costs_by_bucket.labour + 2000);
  });

  it("finances-only OVERSTATES profit vs the labour-inclusive figure (the bug)", () => {
    const financesOnly = computeJobProfitability(JOB, invoices, finances)!;
    const input = buildJobCostInput({
      finances,
      timeEntries: [juneEntry],
      hourlyByUser: hourly,
      hoursForEntries: lifetimeHoursSource(now),
      cycle: "monthly",
      periodStartIso: "2026-06-01",
    });
    const withLabour = computeJobProfitability(JOB, invoices, input)!;

    expect(financesOnly.gross_profit).toBeGreaterThan(withLabour.gross_profit);
    expect(financesOnly.margin_pct!).toBeGreaterThan(withLabour.margin_pct!);
    // The overstatement equals exactly the labour + on-cost that was omitted.
    expect(financesOnly.gross_profit - withLabour.gross_profit).toBe(
      withLabour.costs_by_bucket.labour,
    );
  });

  it("lifetime scope captures earlier-month labour the dashboard window drops", () => {
    // A May entry sits BEFORE the June window. The dashboard month view excludes
    // it (correct for a month tile); the per-job lifetime view includes it
    // (correct for a whole-job commercial page) — the intended scope difference.
    const mayEntry = entry("te-may", "2026-05-10T00:00:00Z", 100);
    const entries = [mayEntry, juneEntry];

    const dashboardInput = buildJobCostInput({
      finances,
      timeEntries: entries,
      hourlyByUser: hourly,
      hoursForEntries: windowHoursSource(monthStart, monthEnd, now),
      cycle: "monthly",
      periodStartIso: "2026-06-01",
    });
    const commercialInput = buildJobCostInput({
      finances,
      timeEntries: entries,
      hourlyByUser: hourly,
      hoursForEntries: lifetimeHoursSource(now),
      cycle: "monthly",
      periodStartIso: "2026-06-01",
    });

    const dash = computeJobProfitability(JOB, invoices, dashboardInput)!;
    const comm = computeJobProfitability(JOB, invoices, commercialInput)!;

    // Lifetime carries the extra 100h × £40 = £4,000 gross (plus its on-costs).
    expect(comm.costs_by_bucket.labour).toBeGreaterThan(dash.costs_by_bucket.labour);
    expect(comm.costs_by_bucket.labour - dash.costs_by_bucket.labour).toBeGreaterThanOrEqual(
      100 * RATE,
    );
  });

  it("with no time entries, the input is finances alone (no phantom labour)", () => {
    const input = buildJobCostInput({
      finances,
      timeEntries: [],
      hourlyByUser: hourly,
      hoursForEntries: lifetimeHoursSource(now),
      cycle: "monthly",
    });
    expect(input).toEqual(finances);
    const p = computeJobProfitability(JOB, invoices, input)!;
    expect(p.costs_by_bucket.labour).toBe(0);
    expect(p.costs_total).toBe(2000);
  });
});

/**
 * Stock COGS as the third cost stream. Stock issued from inventory to a job is a
 * real material cost that is NOT in the job's `finances` rows (stock issues post
 * nothing to `finances`), so before this stream the job margin understated cost by
 * the whole COGS of the stock it consumed. These tests pin that (a) the COGS
 * reaches the materials bucket, (b) it is folded EXACTLY ONCE and is disjoint from
 * finances materials, (c) a job with no stock issue is byte-identical, and (d) the
 * amount matches the valuation fold's rounding exactly.
 */
describe("buildJobCostInput — stock COGS stream", () => {
  const ITEM = "item-1";
  const SITE = "site-1";

  /** A costed movement row carrying the DB-frozen cost facts. */
  function mv(
    id: string,
    type: string,
    qty: number,
    effect: number,
    extra: Partial<CostedMovementRow> = {},
  ): CostedMovementRow {
    return {
      id,
      stock_item_id: ITEM,
      site_id: SITE,
      movement_type: type,
      qty,
      effect,
      ...extra,
    };
  }

  // Receipt of 100 @ £2.50 = £250 capitalised; issue of 40 to JOB releases £100
  // of COGS at the £2.50 weighted average (cost_effect frozen at -100 by the DB).
  const receipt = mv("m-recv", "receipt", 100, 100, {
    cost_effect: 250,
    costed_qty_effect: 100,
    unit_cost: 2.5,
  });
  const issue = mv("m-issue", "issue", 40, -40, {
    cost_effect: -100,
    costed_qty_effect: -40,
    unit_cost: 2.5,
    job_id: JOB,
  });

  it("folds stock COGS into the materials bucket for the consuming job", () => {
    const stockCogs = buildStockCogsCostRows([receipt, issue]);
    // The allocation is the £100 released to JOB, tagged materials.
    expect(stockCogs).toEqual([{ job_id: JOB, amount: 100, category: "materials" }]);

    const input = buildJobCostInput({
      finances: [],
      timeEntries: [],
      hourlyByUser: hourly,
      hoursForEntries: lifetimeHoursSource(now),
      cycle: "monthly",
      stockCogs,
    });
    const p = computeJobProfitability(JOB, invoices, input)!;
    expect(p.costs_by_bucket.materials).toBe(100);
    expect(p.costs_total).toBe(100);
  });

  it("sums a job-direct materials bill and depot-stock COGS as TWO distinct spends", () => {
    // The £2000 finances bill and the £100 stock COGS here are DIFFERENT
    // purchases, not one spend counted twice:
    //   - the £2000 bill comes from a JOB-TAGGED purchase order (recordSupplierBill
    //     copies po.job_id onto the bill). Such a PO can NEVER enter shared stock —
    //     record_stock_receipt_from_grn refuses a job-tagged delivery (migration
    //     20261212000000) — so it is not the source of any COGS;
    //   - the £100 COGS is depot stock (from job-less POs) the job later consumed.
    // Two genuine spends ⇒ the materials bucket is their SUM. The double-count the
    // adversarial review found (ONE spend billed to the job AND issued back to it as
    // COGS) is unreachable by that RPC guard, so this is not it — it is composed
    // once. That unreachability is proven at the RPC in the integration + source
    // guards, not here; this test only pins the pure composition.
    const stockCogs = buildStockCogsCostRows([receipt, issue]);
    const input = buildJobCostInput({
      finances, // { JOB, 2000, materials } — a job-direct bill (non-stocked PO)
      timeEntries: [],
      hourlyByUser: hourly,
      hoursForEntries: lifetimeHoursSource(now),
      cycle: "monthly",
      stockCogs,
    });
    const p = computeJobProfitability(JOB, invoices, input)!;
    expect(p.costs_by_bucket.materials).toBe(2100);
    expect(p.costs_total).toBe(2100);

    // Removing the stock stream drops EXACTLY the £100 — proof it entered once.
    const withoutCogs = computeJobProfitability(
      JOB,
      invoices,
      buildJobCostInput({
        finances,
        timeEntries: [],
        hourlyByUser: hourly,
        hoursForEntries: lifetimeHoursSource(now),
        cycle: "monthly",
      }),
    )!;
    expect(p.costs_total - withoutCogs.costs_total).toBe(100);
  });

  it("a job with no stock issue is byte-identical (omitted param and empty rows)", () => {
    const base = buildJobCostInput({
      finances,
      timeEntries: [juneEntry],
      hourlyByUser: hourly,
      hoursForEntries: lifetimeHoursSource(now),
      cycle: "monthly",
      periodStartIso: "2026-06-01",
    });
    const withEmpty = buildJobCostInput({
      finances,
      timeEntries: [juneEntry],
      hourlyByUser: hourly,
      hoursForEntries: lifetimeHoursSource(now),
      cycle: "monthly",
      periodStartIso: "2026-06-01",
      stockCogs: buildStockCogsCostRows([receipt]), // receipt only, no issue ⇒ []
    });
    expect(withEmpty).toEqual(base);
  });

  it("a correction reversing the issue nets the job's COGS back to zero", () => {
    // The correction is a SEPARATE, job-less row naming the issue; its +100 cancels
    // the issue's -100, so the job carries no phantom COGS after reversal.
    const correction = mv("m-corr", "correction", 40, 40, {
      cost_effect: 100,
      costed_qty_effect: 40,
      unit_cost: 2.5,
      corrects_movement_id: "m-issue",
    });
    expect(stockCogsByJob([receipt, issue, correction]).get(JOB)).toBeUndefined();
    expect(buildStockCogsCostRows([receipt, issue, correction])).toEqual([]);
  });

  it("the folded amount matches the valuation report's rounding", () => {
    // buildJobCostInput must not re-round or re-derive the COGS — the amount it
    // carries is exactly what the valuation fold (stockCogsByJob) produced.
    const rows = [receipt, issue];
    const foldAmount = stockCogsByJob(rows).get(JOB)!;
    const stockCogs = buildStockCogsCostRows(rows);
    const p = computeJobProfitability(
      JOB,
      invoices,
      buildJobCostInput({
        finances: [],
        timeEntries: [],
        hourlyByUser: hourly,
        hoursForEntries: lifetimeHoursSource(now),
        cycle: "monthly",
        stockCogs,
      }),
    )!;
    expect(p.costs_by_bucket.materials).toBe(foldAmount);
  });
});

describe("buildLabourSlices — grouping equals per-entry accumulation", () => {
  it("sums per (job,user) group identically to measuring each entry alone", () => {
    // Two entries for the same (job, user) inside the window: the grouped slice's
    // hours must equal the sum of each entry measured on its own — the property
    // that makes the shared builder byte-for-byte match the dashboard's original
    // per-entry loop.
    const e1 = entry("e1", "2026-06-03T00:00:00Z", 5);
    const e2 = entry("e2", "2026-06-04T00:00:00Z", 3);
    const src = windowHoursSource(monthStart, monthEnd, now);
    const slices = buildLabourSlices([e1, e2], src);
    expect(slices).toHaveLength(1);
    expect(slices[0]!.hours).toBeCloseTo(src([e1]) + src([e2]), 5);
    expect(slices[0]!.hours).toBeCloseTo(8, 5);
  });

  it("drops entries with no job_id and zero-hour groups", () => {
    const noJob = entry("e-nojob", "2026-06-03T00:00:00Z", 5, null);
    const slices = buildLabourSlices([noJob], lifetimeHoursSource(now));
    expect(slices).toHaveLength(0);
  });
});
