import { describe, it, expect } from "vitest";
import {
  mapToCostBucket,
  marginBand,
  UNIVERSAL_TARGET_MARGIN_PCT,
  computeJobProfitability,
  computeAllJobsProfitability,
  topProfitableJobs,
  worstJobs,
  averageMargin,
  totalProfitThisMonth,
  profitByMonth,
} from "@/lib/profitability/compute";

describe("mapToCostBucket", () => {
  it("maps existing finance categories onto the 4 profitability buckets", () => {
    expect(mapToCostBucket("labour")).toBe("labour");
    expect(mapToCostBucket("labor")).toBe("labour");
    expect(mapToCostBucket("materials")).toBe("materials");
    expect(mapToCostBucket("subcontractor")).toBe("subcontractors");
    expect(mapToCostBucket("subcontractors")).toBe("subcontractors");
    // Fuel/tools/office/vehicle/anything-else → misc
    expect(mapToCostBucket("fuel")).toBe("misc");
    expect(mapToCostBucket("tools")).toBe("misc");
    expect(mapToCostBucket("office")).toBe("misc");
    expect(mapToCostBucket("vehicle")).toBe("misc");
    expect(mapToCostBucket("misc")).toBe("misc");
    expect(mapToCostBucket(null)).toBe("misc");
    expect(mapToCostBucket(undefined)).toBe("misc");
    expect(mapToCostBucket("")).toBe("misc");
  });
});

describe("marginBand", () => {
  it("green for margin > 30%, amber for 15–30%, red for < 15%, neutral for null", () => {
    expect(marginBand(50)).toBe("green");
    expect(marginBand(31)).toBe("green");
    expect(marginBand(30)).toBe("amber"); // not > 30, so not green
    expect(marginBand(20)).toBe("amber");
    expect(marginBand(15)).toBe("amber");
    expect(marginBand(14.99)).toBe("red");
    expect(marginBand(0)).toBe("red");
    expect(marginBand(-10)).toBe("red");
    expect(marginBand(null)).toBe("neutral");
  });

  // ── per-job target (20261072) ─────────────────────────────────────────────
  // `marginBand` now PREFERS a per-job target when the job's cost baseline
  // carries one. The universal 30/15 stays the fallback, and the fallback path
  // must be byte-for-byte what it always was.

  it("BEHAVIOUR IS UNCHANGED for a job with no budget — the fallback IS the old function", () => {
    // Every margin the old test pinned, plus the boundaries, asserted two ways:
    // omitting the argument and passing null must both give the published bands.
    for (const m of [100, 50, 31, 30.01, 30, 29.99, 20, 15, 14.99, 0, -10, -100]) {
      expect(marginBand(m, null), `null target at ${m}%`).toBe(marginBand(m));
      expect(marginBand(m, undefined), `undefined target at ${m}%`).toBe(marginBand(m));
      // …and the universal target is literally 30, so passing it changes nothing.
      expect(marginBand(m, UNIVERSAL_TARGET_MARGIN_PCT), `explicit 30 at ${m}%`).toBe(
        marginBand(m),
      );
    }
    expect(marginBand(null, 12)).toBe("neutral"); // no margin ⇒ nothing to band
  });

  it("bands against the job's OWN target when one is set", () => {
    // A 12% target: 12 is the green line, 6 (half) the amber floor. Under the
    // universal bands every one of these would be red, which is the defect —
    // an on-plan job painted as a failure.
    expect(marginBand(20, 12)).toBe("green");
    expect(marginBand(12.5, 12)).toBe("green");
    expect(marginBand(12, 12)).toBe("amber"); // not > target, same rule as 30
    expect(marginBand(6, 12)).toBe("amber");
    expect(marginBand(5.99, 12)).toBe("red");

    // A demanding 50% target: 25 is the amber floor, so a 40% margin — green
    // under the universal bands — is amber against this job's own plan.
    expect(marginBand(40, 50)).toBe("amber");
    expect(marginBand(51, 50)).toBe("green");
    expect(marginBand(24, 50)).toBe("red");
  });

  it("honours a ZERO target (break-even is fine) but ignores a nonsense one", () => {
    expect(marginBand(0.1, 0)).toBe("green");
    expect(marginBand(0, 0)).toBe("amber");
    expect(marginBand(-0.1, 0)).toBe("red");
    // Negative / non-finite targets fall back rather than inverting the bands.
    expect(marginBand(20, -5)).toBe(marginBand(20));
    expect(marginBand(20, Number.NaN)).toBe(marginBand(20));
    expect(marginBand(10, Number.POSITIVE_INFINITY)).toBe(marginBand(10));
  });
});

describe("computeJobProfitability", () => {
  const invoices = [
    { job_id: "job-A", amount: 1000 }, // revenue counted
    { job_id: "job-A", amount: 500 },
    { job_id: "job-B", amount: 2000 },
    { job_id: null, amount: 999 }, // ignored — no job link
  ];
  const finances = [
    { job_id: "job-A", amount: 300, category: "labour" },
    { job_id: "job-A", amount: 200, category: "materials" },
    { job_id: "job-A", amount: 50, category: "fuel" }, // → misc
    { job_id: "job-B", amount: 900, category: "subcontractor" },
    { job_id: null, amount: 100, category: "labour" }, // ignored
  ];

  it("revenue/cost/profit/margin for a single job with multiple invoices and cost lines", () => {
    const a = computeJobProfitability("job-A", invoices, finances);
    expect(a).not.toBeNull();
    expect(a!.revenue).toBe(1500);
    expect(a!.costs_total).toBe(550);
    expect(a!.costs_by_bucket).toEqual({
      labour: 300,
      materials: 200,
      subcontractors: 0,
      misc: 50,
    });
    expect(a!.gross_profit).toBe(950);
    // 950/1500 = 63.33% → rounds to 63
    expect(a!.margin_pct).toBe(63);
    expect(a!.band).toBe("green");
  });

  it("returns null for a job with neither revenue nor cost", () => {
    const c = computeJobProfitability("job-C", invoices, finances);
    expect(c).toBeNull();
  });

  it("margin is null when revenue is 0 but costs > 0 (e.g. work logged before invoicing)", () => {
    const noRevInvoices: Array<{ job_id: string | null; amount: number }> = [];
    const onlyCosts = [{ job_id: "job-Z", amount: 200, category: "labour" }];
    const z = computeJobProfitability("job-Z", noRevInvoices, onlyCosts);
    expect(z!.revenue).toBe(0);
    expect(z!.costs_total).toBe(200);
    expect(z!.gross_profit).toBe(-200);
    expect(z!.margin_pct).toBeNull();
    expect(z!.band).toBe("neutral");
  });
});

describe("dashboard roll-ups", () => {
  const jobs = [{ id: "A" }, { id: "B" }, { id: "C" }];
  const invoices = [
    { job_id: "A", amount: 1000 }, // margin 50%
    { job_id: "B", amount: 2000 }, // margin 10%
    { job_id: "C", amount: 100 }, // margin -100% (loss)
  ];
  const finances = [
    { job_id: "A", amount: 500, category: "labour" },
    { job_id: "B", amount: 1800, category: "labour" },
    { job_id: "C", amount: 200, category: "labour" },
  ];

  it("topProfitableJobs orders by absolute gross_profit desc", () => {
    const rows = computeAllJobsProfitability(jobs, invoices, finances);
    const top = topProfitableJobs(rows, 5);
    expect(top.map((r) => r.job_id)).toEqual(["A", "B", "C"]);
    expect(top[0]!.gross_profit).toBe(500);
  });

  it("worstJobs orders by margin asc and excludes null-margin jobs", () => {
    const rows = computeAllJobsProfitability(jobs, invoices, finances);
    const worst = worstJobs(rows, 5);
    // C has the worst margin (-100%), then B (10%), then A (50%)
    expect(worst.map((r) => r.job_id)).toEqual(["C", "B", "A"]);
  });

  it("averageMargin ignores null-margin rows", () => {
    const rows = computeAllJobsProfitability(jobs, invoices, finances);
    // (50 + 10 + -100) / 3 = -13.33 → rounds to -13
    expect(averageMargin(rows)).toBe(-13);
  });

  it("returns null average when no jobs have revenue", () => {
    const noRev = computeAllJobsProfitability(
      [{ id: "X" }],
      [],
      [{ job_id: "X", amount: 100, category: "labour" }],
    );
    expect(averageMargin(noRev)).toBeNull();
  });
});

describe("monthly series", () => {
  it("profitByMonth pre-fills the requested window and aggregates correctly", () => {
    const now = new Date("2026-05-20T00:00:00Z");
    const series = profitByMonth(
      [
        { amount: 1000, created_at: "2026-05-10T00:00:00Z" },
        { amount: 500, created_at: "2026-04-15T00:00:00Z" },
        { amount: 999, created_at: "2025-10-01T00:00:00Z" }, // outside 6-month window
      ],
      [{ amount: 300, created_at: "2026-05-12T00:00:00Z" }],
      6,
      "created_at",
      now,
    );
    expect(series).toHaveLength(6);
    // 6-month window ending May 2026: Dec 2025 → May 2026 inclusive
    expect(series.map((b) => b.month)).toEqual([
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
      "2026-05",
    ]);
    const may = series.find((b) => b.month === "2026-05")!;
    expect(may.revenue).toBe(1000);
    expect(may.costs).toBe(300);
    expect(may.profit).toBe(700);
    const apr = series.find((b) => b.month === "2026-04")!;
    expect(apr.revenue).toBe(500);
    expect(apr.profit).toBe(500);
    // 2025-10 is outside the 6-month window — excluded
    expect(series.find((b) => b.month === "2025-10")).toBeUndefined();
  });

  it("totalProfitThisMonth sums invoices - finances dated within the current calendar month", () => {
    const now = new Date("2026-05-20T00:00:00Z");
    const p = totalProfitThisMonth(
      [
        { amount: 1500, created_at: "2026-05-10T00:00:00Z" },
        { amount: 100, created_at: "2026-04-30T23:59:59Z" }, // last month, excluded
      ],
      [
        { amount: 200, created_at: "2026-05-01T00:00:00Z" },
        { amount: 50, created_at: "2026-04-15T00:00:00Z" }, // last month, excluded
      ],
      now,
    );
    expect(p).toBe(1300); // 1500 - 200
  });
});
