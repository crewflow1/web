import { describe, it, expect } from "vitest";
import {
  buildJobCostInput,
  buildLabourSlices,
  windowHoursSource,
  lifetimeHoursSource,
} from "@/lib/profitability/job-cost-input";
import { computeJobProfitability } from "@/lib/profitability/compute";
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
