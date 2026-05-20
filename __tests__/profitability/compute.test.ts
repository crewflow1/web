import { describe, it, expect } from "vitest";
import {
  mapToCostBucket,
  marginBand,
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
