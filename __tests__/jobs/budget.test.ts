import { describe, expect, it } from "vitest";
import {
  budgetBuckets,
  computeJobBudgetPosition,
  hasBudgetPosition,
  varianceTone,
  type JobBudgetRow,
  type VariationCostEstimate,
} from "@/lib/jobs/budget";

/**
 * Job cost baseline — budget vs actual, variance, forecast final cost and the
 * cost-value reconciliation (20261072).
 *
 * The figures a builder acts on, so every one of them is pinned with worked
 * arithmetic rather than a shape assertion.
 */

const NO_ACTUALS = { labour: 0, materials: 0, subcontractors: 0, misc: 0 };

const budgetRow = (over: Partial<JobBudgetRow> = {}): JobBudgetRow => ({
  revision: 1,
  total_cost: 40000,
  labour_cost: null,
  materials_cost: null,
  subcontractors_cost: null,
  misc_cost: null,
  target_margin_pct: null,
  note: null,
  created_at: "2026-07-01T09:00:00Z",
  ...over,
});

const estimate = (over: Partial<VariationCostEstimate> = {}): VariationCostEstimate => ({
  total_cost: 0,
  labour_cost: 0,
  materials_cost: 0,
  subcontractors_cost: 0,
  misc_cost: 0,
  ...over,
});

describe("a job with NO baseline", () => {
  const p = computeJobBudgetPosition({
    budget: null,
    approvedVariationEstimates: [],
    actualTotal: 18000,
    actualByBucket: { labour: 8000, materials: 9000, subcontractors: 1000, misc: 0 },
    remainingCommitted: 4000,
    revisedValueNet: 50000,
  });

  it("reports NO budget and NO variance — never a £0 budget", () => {
    // "£0 budget, 100% over" is the lie a default would tell; absent is the
    // truth, and it is what makes the UI prompt for a baseline instead of
    // rendering a fake one.
    expect(p.hasBudget).toBe(false);
    expect(p.revisedBudget).toBe(0);
    expect(p.variancePct).toBeNull();
    expect(p.buckets.every((b) => b.budget === null && b.variance === null)).toBe(true);
  });

  it("still forecasts and still reconciles — a forecast needs no plan", () => {
    expect(p.actual).toBe(18000);
    expect(p.remainingCommitted).toBe(4000);
    expect(p.forecastFinalCost).toBe(22000); // 18000 + 4000
    expect(p.revisedValue).toBe(50000);
    expect(p.forecastProfit).toBe(28000); // 50000 − 22000
    expect(p.forecastMarginPct).toBe(56); // 28000 / 50000
  });

  it("still carries the ACTUAL per bucket, so the breakdown is not blank", () => {
    expect(p.buckets.map((b) => [b.bucket, b.actual])).toEqual([
      ["labour", 8000],
      ["materials", 9000],
      ["subcontractors", 1000],
      ["misc", 0],
    ]);
  });

  it("is worth rendering only once there is something to say", () => {
    const empty = {
      budget: null as JobBudgetRow | null,
      approvedVariationEstimates: [] as VariationCostEstimate[],
      actualTotal: 0,
      actualByBucket: NO_ACTUALS,
      remainingCommitted: 0,
      revisedValueNet: 0,
    };
    expect(hasBudgetPosition(p)).toBe(true); // spend AND orders
    // Each clause on its own is enough…
    expect(hasBudgetPosition(computeJobBudgetPosition({ ...empty, actualTotal: 1 }))).toBe(true);
    expect(hasBudgetPosition(computeJobBudgetPosition({ ...empty, remainingCommitted: 1 }))).toBe(true);
    expect(
      hasBudgetPosition(computeJobBudgetPosition({ ...empty, budget: budgetRow() })),
    ).toBe(true);
    // …and with none of them the honest surface is the prompt, not a row of zeroes.
    expect(hasBudgetPosition(computeJobBudgetPosition(empty))).toBe(false);
  });
});

describe("total-only baseline", () => {
  const p = computeJobBudgetPosition({
    budget: budgetRow({ total_cost: 40000 }),
    approvedVariationEstimates: [],
    actualTotal: 31000,
    actualByBucket: { labour: 20000, materials: 9000, subcontractors: 2000, misc: 0 },
    remainingCommitted: 6000,
    revisedValueNet: 50000,
  });

  it("gives budget, spend and variance both ways", () => {
    expect(p.hasBudget).toBe(true);
    expect(p.revision).toBe(1);
    expect(p.revisedBudget).toBe(40000);
    expect(p.actual).toBe(31000);
    expect(p.variance).toBe(9000); // 40000 − 31000, money LEFT
    expect(p.variancePct).toBe(22.5); // 9000 / 40000
    expect(p.overBudget).toBe(false);
  });

  it("forecasts final cost as spend + remaining commitment", () => {
    expect(p.forecastFinalCost).toBe(37000); // 31000 + 6000
    expect(p.forecastVariance).toBe(3000); // 40000 − 37000
    expect(p.forecastVariancePct).toBe(7.5);
    expect(p.forecastOverBudget).toBe(false);
  });

  it("reconciles cost against the NET contract value", () => {
    expect(p.revisedValue).toBe(50000);
    expect(p.plannedProfit).toBe(10000); // 50000 − 40000 budget
    expect(p.plannedMarginPct).toBe(20);
    expect(p.forecastProfit).toBe(13000); // 50000 − 37000 forecast
    expect(p.forecastMarginPct).toBe(26);
  });

  it("carries NO bucket budget, but keeps the actual per bucket", () => {
    expect(p.hasBucketDetail).toBe(false);
    expect(p.buckets.find((b) => b.bucket === "labour")).toEqual({
      bucket: "labour",
      budget: null,
      actual: 20000,
      variance: null,
      variancePct: null,
    });
  });
});

describe("an OVERSPENT job", () => {
  const p = computeJobBudgetPosition({
    budget: budgetRow({ total_cost: 20000, revision: 3, note: "re-scoped" }),
    approvedVariationEstimates: [],
    actualTotal: 24000,
    actualByBucket: { labour: 24000, materials: 0, subcontractors: 0, misc: 0 },
    remainingCommitted: 1500,
    revisedValueNet: 25000,
  });

  it("reports the overspend as a NEGATIVE variance, not an absolute", () => {
    // The sign is the whole message. An absolute figure would read identically
    // whether the job is £4k up or £4k down.
    expect(p.variance).toBe(-4000);
    expect(p.variancePct).toBe(-20);
    expect(p.overBudget).toBe(true);
    expect(varianceTone(p.variance)).toBe("bad");
  });

  it("carries the overspend into the forecast", () => {
    expect(p.forecastFinalCost).toBe(25500); // 24000 + 1500
    expect(p.forecastVariance).toBe(-5500);
    expect(p.forecastOverBudget).toBe(true);
    // …and the forecast eats the whole planned profit
    expect(p.plannedProfit).toBe(5000);
    expect(p.forecastProfit).toBe(-500);
  });

  it("surfaces the revision and its reason", () => {
    expect(p.revision).toBe(3);
    expect(p.note).toBe("re-scoped");
  });
});

describe("bucket detail", () => {
  const p = computeJobBudgetPosition({
    budget: budgetRow({
      total_cost: 40000,
      labour_cost: 18000,
      materials_cost: 15000,
      subcontractors_cost: 5000,
      misc_cost: 2000,
    }),
    approvedVariationEstimates: [],
    actualTotal: 26500,
    actualByBucket: { labour: 19000, materials: 6000, subcontractors: 1000, misc: 500 },
    remainingCommitted: 0,
    revisedValueNet: 50000,
  });

  it("gives a per-bucket variance in the same four buckets the actuals use", () => {
    expect(p.hasBucketDetail).toBe(true);
    expect(p.buckets).toEqual([
      { bucket: "labour", budget: 18000, actual: 19000, variance: -1000, variancePct: -5.56 },
      { bucket: "materials", budget: 15000, actual: 6000, variance: 9000, variancePct: 60 },
      { bucket: "subcontractors", budget: 5000, actual: 1000, variance: 4000, variancePct: 80 },
      { bucket: "misc", budget: 2000, actual: 500, variance: 1500, variancePct: 75 },
    ]);
  });

  it("keeps the bucket budgets summing to the revised budget", () => {
    const summed = p.buckets.reduce((s, b) => s + (b.budget ?? 0), 0);
    expect(summed).toBe(p.revisedBudget);
  });

  it("reads the four columns, and treats an absent breakdown as absent", () => {
    expect(budgetBuckets(budgetRow({ labour_cost: null }))).toBeNull();
    expect(budgetBuckets(null)).toBeNull();
    expect(
      budgetBuckets(
        budgetRow({
          labour_cost: "1.5",
          materials_cost: "2.5",
          subcontractors_cost: 0,
          misc_cost: 0,
        }),
      ),
    ).toEqual({ labour: 1.5, materials: 2.5, subcontractors: 0, misc: 0 });
  });

  it("a bucket budgeted at ZERO gives no percentage, and no Infinity", () => {
    const z = computeJobBudgetPosition({
      budget: budgetRow({
        total_cost: 1000,
        labour_cost: 1000,
        materials_cost: 0,
        subcontractors_cost: 0,
        misc_cost: 0,
      }),
      approvedVariationEstimates: [],
      actualTotal: 300,
      actualByBucket: { labour: 0, materials: 300, subcontractors: 0, misc: 0 },
      remainingCommitted: 0,
      revisedValueNet: 0,
    });
    const materials = z.buckets.find((b) => b.bucket === "materials")!;
    expect(materials.variance).toBe(-300);
    expect(materials.variancePct).toBeNull();
  });
});

describe("APPROVED variations join the cost plan", () => {
  // The defect this closes: accepting a variation added its value to the revised
  // CONTRACT and nothing to the cost plan, so every approved variation silently
  // improved the apparent margin.
  const estimates = [
    estimate({ total_cost: 6000, labour_cost: 4000, materials_cost: 1500, misc_cost: 500 }),
    estimate({ total_cost: 2000, subcontractors_cost: 2000 }),
  ];

  it("adds their cost estimates to the revised budget", () => {
    const p = computeJobBudgetPosition({
      budget: budgetRow({ total_cost: 40000 }),
      approvedVariationEstimates: estimates,
      actualTotal: 0,
      actualByBucket: NO_ACTUALS,
      remainingCommitted: 0,
      revisedValueNet: 60000,
    });
    expect(p.baseline).toBe(40000);
    expect(p.approvedVariationCost).toBe(8000);
    expect(p.revisedBudget).toBe(48000);
    expect(p.plannedProfit).toBe(12000); // 60000 − 48000, NOT 60000 − 40000
  });

  it("folds their buckets in too, so the breakdown still adds up", () => {
    const p = computeJobBudgetPosition({
      budget: budgetRow({
        total_cost: 40000,
        labour_cost: 18000,
        materials_cost: 15000,
        subcontractors_cost: 5000,
        misc_cost: 2000,
      }),
      approvedVariationEstimates: estimates,
      actualTotal: 0,
      actualByBucket: NO_ACTUALS,
      remainingCommitted: 0,
      revisedValueNet: 60000,
    });
    expect(p.buckets.map((b) => [b.bucket, b.budget])).toEqual([
      ["labour", 22000], // 18000 + 4000
      ["materials", 16500], // 15000 + 1500
      ["subcontractors", 7000], // 5000 + 2000
      ["misc", 2500], // 2000 + 500
    ]);
    expect(p.buckets.reduce((s, b) => s + (b.budget ?? 0), 0)).toBe(p.revisedBudget);
  });

  it("leaves the breakdown ABSENT when the baseline has none, rather than inventing one", () => {
    const p = computeJobBudgetPosition({
      budget: budgetRow({ total_cost: 40000 }),
      approvedVariationEstimates: estimates,
      actualTotal: 0,
      actualByBucket: NO_ACTUALS,
      remainingCommitted: 0,
      revisedValueNet: 60000,
    });
    // The variations ARE bucketed, but a breakdown built from them alone would
    // sum to £8k against a £48k budget — a column that does not add up.
    expect(p.hasBucketDetail).toBe(false);
    expect(p.buckets.every((b) => b.budget === null)).toBe(true);
  });
});

describe("the per-job margin target", () => {
  it("is surfaced for marginBand() when set, and null when not", () => {
    expect(
      computeJobBudgetPosition({
        budget: budgetRow({ target_margin_pct: 12.5 }),
        approvedVariationEstimates: [],
        actualTotal: 0,
        actualByBucket: NO_ACTUALS,
        remainingCommitted: 0,
        revisedValueNet: 0,
      }).targetMarginPct,
    ).toBe(12.5);
    expect(
      computeJobBudgetPosition({
        budget: budgetRow(),
        approvedVariationEstimates: [],
        actualTotal: 0,
        actualByBucket: NO_ACTUALS,
        remainingCommitted: 0,
        revisedValueNet: 0,
      }).targetMarginPct,
    ).toBeNull();
  });
});

describe("money handling", () => {
  it("coerces numeric-strings (the `numeric` wire format) without drift", () => {
    const p = computeJobBudgetPosition({
      budget: budgetRow({ total_cost: "100.10", revision: "2" }),
      approvedVariationEstimates: [estimate({ total_cost: "0.20" })],
      actualTotal: 0.1,
      actualByBucket: NO_ACTUALS,
      remainingCommitted: "0.20" as unknown as number,
      revisedValueNet: 0,
    });
    expect(p.baseline).toBe(100.1);
    expect(p.approvedVariationCost).toBe(0.2);
    expect(p.revisedBudget).toBe(100.3);
    expect(p.revision).toBe(2);
    expect(p.forecastFinalCost).toBe(0.3);
  });

  it("never treats a NEGATIVE remaining commitment as a credit against spend", () => {
    // committed.ts floors per PO, but this module is the last line: a negative
    // "cost to complete" would make a forecast lower than money already spent.
    const p = computeJobBudgetPosition({
      budget: budgetRow({ total_cost: 1000 }),
      approvedVariationEstimates: [],
      actualTotal: 900,
      actualByBucket: NO_ACTUALS,
      remainingCommitted: -500,
      revisedValueNet: 0,
    });
    expect(p.remainingCommitted).toBe(0);
    expect(p.forecastFinalCost).toBe(900);
  });

  it("gives no percentage when there is nothing to divide by", () => {
    const p = computeJobBudgetPosition({
      budget: budgetRow({ total_cost: 0, target_margin_pct: 25 }),
      approvedVariationEstimates: [],
      actualTotal: 0,
      actualByBucket: NO_ACTUALS,
      remainingCommitted: 0,
      revisedValueNet: 0,
    });
    expect(p.variancePct).toBeNull();
    expect(p.forecastVariancePct).toBeNull();
    expect(p.plannedMarginPct).toBeNull();
    expect(p.forecastMarginPct).toBeNull();
  });
});

describe("varianceTone", () => {
  it("reads from the viewer's point of view: money left is good", () => {
    expect(varianceTone(1)).toBe("good");
    expect(varianceTone(-1)).toBe("bad");
    expect(varianceTone(0)).toBe("neutral");
  });
});
