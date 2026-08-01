import { describe, it, expect } from "vitest";
import { computeJobBudgetPosition, type JobBudgetPosition } from "@/lib/jobs/budget";
import {
  CVR_AMBER_HEADROOM_PCT,
  computeCvrRollup,
  cvrBand,
  cvrBandsMetric,
  cvrTotalMetric,
  type CvrJobInput,
} from "@/lib/intelligence/cvr-rollup";

/**
 * CVR rollup — positions are built through the BUDGET AUTHORITY itself
 * (computeJobBudgetPosition), never hand-rolled, so the rollup is tested
 * against exactly what it composes in production.
 */

function position(input: {
  budget: number | null;
  actual: number;
  committed: number;
}): JobBudgetPosition {
  return computeJobBudgetPosition({
    budget:
      input.budget == null
        ? null
        : {
            revision: 1,
            total_cost: input.budget,
            labour_cost: null,
            materials_cost: null,
            subcontractors_cost: null,
            misc_cost: null,
            target_margin_pct: null,
            note: null,
            created_at: "2026-06-01T00:00:00Z",
          },
    approvedVariationEstimates: [],
    actualTotal: input.actual,
    actualByBucket: { labour: input.actual, materials: 0, subcontractors: 0, misc: 0 },
    remainingCommitted: input.committed,
    revisedValueNet: 0,
  });
}

function job(id: string, p: JobBudgetPosition): CvrJobInput {
  return { jobId: id, label: `Site ${id}`, href: `/jobs/${id}/commercial`, position: p };
}

const red = position({ budget: 1000, actual: 900, committed: 200 }); // forecast 1100 > 1000
const amber = position({ budget: 1000, actual: 800, committed: 150 }); // forecast 950, 5% headroom
const ok = position({ budget: 1000, actual: 500, committed: 100 }); // forecast 600, 40% headroom
const unbudgeted = position({ budget: null, actual: 700, committed: 0 });

describe("cvrBand — the stated rules", () => {
  it("red when the floor forecast already exceeds the revised budget", () => {
    expect(red.forecastOverBudget).toBe(true);
    expect(cvrBand(red)).toBe("red");
  });

  it(`amber when headroom is under ${CVR_AMBER_HEADROOM_PCT}% of budget`, () => {
    expect(amber.forecastVariancePct).toBe(5);
    expect(cvrBand(amber)).toBe("amber");
  });

  it("boundary: exactly 10% headroom is NOT amber", () => {
    const atLine = position({ budget: 1000, actual: 800, committed: 100 }); // variance 100 = 10%
    expect(atLine.forecastVariancePct).toBe(10);
    expect(cvrBand(atLine)).toBe("ok");
  });
});

describe("computeCvrRollup", () => {
  const rollup = computeCvrRollup([
    job("a", red),
    job("b", amber),
    job("c", ok),
    job("d", unbudgeted),
  ]);

  it("sums forecast variance over BUDGETED jobs only", () => {
    // red: 1000−1100 = −100; amber: 1000−950 = 50; ok: 1000−600 = 400.
    expect(rollup.forecastVarianceTotal).toBe(350);
    expect(rollup.jobsWithBudget).toBe(3);
  });

  it("discloses unbudgeted jobs and never sums them", () => {
    // The unbudgeted job spent £700; folding it in would swing the total by
    // −700 — the exact lie the NO_BUDGET convention exists to refuse.
    expect(rollup.jobsWithoutBudget).toBe(1);
    expect(rollup.lines.find((l) => l.jobId === "d")).toBeUndefined();
  });

  it("counts and orders bands worst first", () => {
    expect(rollup.redCount).toBe(1);
    expect(rollup.amberCount).toBe(1);
    expect(rollup.lines.map((l) => l.jobId)).toEqual(["a", "b", "c"]);
  });
});

describe("provenance", () => {
  const rollup = computeCvrRollup([job("a", red)]);

  it("the total is derived and names the floor-forecast rule", () => {
    const m = cvrTotalMetric(rollup);
    expect(m.provenance.kind).toBe("derived");
    expect(m.provenance.basis).toContain("actual spend + committed-but-unbilled");
    expect(m.provenance.basis).toContain("FLOOR");
  });

  it("the bands are heuristic and quote the amber threshold", () => {
    const m = cvrBandsMetric(rollup);
    expect(m.provenance.kind).toBe("heuristic");
    expect(m.provenance.basis).toContain(`${CVR_AMBER_HEADROOM_PCT}%`);
  });
});
