import { describe, it, expect } from "vitest";
import {
  computeCompanyHealth,
  DEFAULT_HEALTH_THRESHOLDS,
  HEALTH_DIMENSION_ORDER,
  type CompanyHealthInput,
  type HealthBand,
  type HealthDimensionKey,
} from "@/lib/health/company-health";
import { ratio, type Ratio } from "@/lib/suppliers/performance";
import type { AgedDebtSummary, RetentionExposure } from "@/lib/intelligence/exposure";
import type { CvrRollup } from "@/lib/intelligence/cvr-rollup";
import type { ProgressRollup } from "@/lib/intelligence/progress-rollup";
import type { ProgrammeVarianceRollup } from "@/lib/intelligence/programme-variance";
import type { SupplierPerformanceRollup } from "@/lib/intelligence/supplier-performance";
import type { HsSnapshot } from "@/lib/health-safety/signals";
import type { JobProfitability } from "@/lib/profitability/compute";

/**
 * COMPANY HEALTH — per-dimension banding. The honesty rule under test above all:
 * absence of data is `insufficient`, NEVER green — proved hardest for SAFETY.
 */

// ---------------------------------------------------------------------------
// Fixture factories (full-shaped, override only what a case cares about)
// ---------------------------------------------------------------------------

function agedDebt(o: Partial<AgedDebtSummary> = {}): AgedDebtSummary {
  return {
    total: 0,
    pastDue: 0,
    over90: 0,
    d61to90: 0,
    undated: 0,
    debtorCount: 0,
    invoiceCount: 0,
    ...o,
  };
}

function retention(o: Partial<RetentionExposure> = {}): RetentionExposure {
  return {
    heldTotal: 0,
    notYetDue: 0,
    awaitingCompletion: 0,
    claimableNow: 0,
    jobsHolding: 0,
    jobsOverdue: 0,
    ...o,
  };
}

function cvr(o: Partial<CvrRollup> = {}): CvrRollup {
  return {
    jobsConsidered: 0,
    jobsWithBudget: 0,
    jobsWithoutBudget: 0,
    forecastVarianceTotal: 0,
    redCount: 0,
    amberCount: 0,
    lines: [],
    ...o,
  };
}

function progress(o: Partial<ProgressRollup> = {}): ProgressRollup {
  return { activeJobs: 0, assessedJobs: 0, neverAssessed: 0, stalled: [], regressing: [], ...o };
}

function programme(o: Partial<ProgrammeVarianceRollup> = {}): ProgrammeVarianceRollup {
  return {
    jobsConsidered: 0,
    jobsWithBaseline: 0,
    jobsWithoutBaseline: 0,
    behindBaseline: [],
    overdueMilestoneCount: 0,
    jobsWithOverdueMilestones: 0,
    openEotWorkingDaysLost: 0,
    openEotEventCount: 0,
    openEotUnquantifiedCount: 0,
    recordedDelayEventCount: 0,
    withdrawnDelayEventCount: 0,
    draftDelayEventCount: 0,
    ...o,
  };
}

function snapshot(o: Partial<HsSnapshot> = {}): HsSnapshot {
  return {
    ramsDraft: 0,
    ramsReviewOverdue: 0,
    permitsExpiringSoon: 0,
    permitsExpiredLive: 0,
    activeJobsNoCurrentRams: 0,
    highResidualRams: 0,
    toolboxAwaitingAck: 0,
    ...o,
  };
}

function supplierRollup(o: Partial<SupplierPerformanceRollup> = {}): SupplierPerformanceRollup {
  return {
    suppliersConsidered: 0,
    suppliersWithRecord: 0,
    suppliersEmpty: 0,
    orgPunctuality: ratio(0, 0),
    mostReliable: [],
    leastReliable: [],
    withheldDeliveryRating: 0,
    slowestSettling: [],
    withheldSettlementRating: 0,
    overBillingFlags: [],
    withheldPriceRating: 0,
    overBilledExcessTotal: 0,
    slowSettlementFlags: [],
    ...o,
  };
}

/** A behind-baseline job stub — the banding only reads array length. */
const behindJobs = (n: number): ProgrammeVarianceRollup["behindBaseline"] =>
  Array.from({ length: n }, (_, i) => ({
    jobId: `j${i}`,
    label: null,
    href: "/",
    daysOverdue: 1,
    plannedEnd: "2026-01-01",
    revision: 1,
  })) as unknown as ProgrammeVarianceRollup["behindBaseline"];

const stalledJobs = (n: number): ProgressRollup["stalled"] =>
  Array.from({ length: n }, (_, i) => ({ jobId: `s${i}` })) as unknown as ProgressRollup["stalled"];

const overBillFlags = (n: number): SupplierPerformanceRollup["overBillingFlags"] =>
  Array.from({ length: n }, (_, i) => ({ supplierId: `ob${i}` })) as unknown as SupplierPerformanceRollup["overBillingFlags"];

const slowFlags = (n: number): SupplierPerformanceRollup["slowSettlementFlags"] =>
  Array.from({ length: n }, (_, i) => ({ supplierId: `ss${i}` })) as unknown as SupplierPerformanceRollup["slowSettlementFlags"];

function profitRow(marginPct: number | null): JobProfitability {
  return {
    job_id: `job-${marginPct}`,
    revenue: marginPct === null ? 0 : 1000,
    costs_total: 0,
    costs_by_bucket: { labour: 0, materials: 0, subcontractors: 0, misc: 0 },
    gross_profit: 0,
    margin_pct: marginPct,
    band: "neutral",
  };
}

/** A fully-populated, all-green-ish input; tests override the group under test. */
function baseInput(): CompanyHealthInput {
  return {
    cash: { agedDebt: agedDebt({ total: 1000 }), retention: retention(), cvr: cvr() },
    delivery: {
      progress: progress({ activeJobs: 3, assessedJobs: 3 }),
      programme: programme({ jobsConsidered: 3, jobsWithBaseline: 3 }),
    },
    safety: { snapshot: snapshot(), hasAnySafetyRecord: true },
    supplier: supplierRollup({ suppliersWithRecord: 4, orgPunctuality: ratio(1, 10) }),
    profitability: [profitRow(40)],
  };
}

function bandOf(input: CompanyHealthInput, key: HealthDimensionKey): HealthBand {
  const dim = computeCompanyHealth(input).dimensions.find((d) => d.key === key);
  if (!dim) throw new Error(`missing dimension ${key}`);
  return dim.band;
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe("computeCompanyHealth — structure", () => {
  it("returns exactly the five dimensions in the fixed order", () => {
    const h = computeCompanyHealth(baseInput());
    expect(h.dimensions.map((d) => d.key)).toEqual([...HEALTH_DIMENSION_ORDER]);
    expect(h.dimensions).toHaveLength(5);
  });

  it("never emits a blended overall score", () => {
    const h = computeCompanyHealth(baseInput());
    // The whole doctrine: no single combined number exists on the result.
    expect(Object.keys(h)).toEqual(["dimensions"]);
    for (const d of h.dimensions) {
      expect(d.kind).toBe("heuristic");
      expect(d.basis.length).toBeGreaterThan(0);
      expect(d.drillThrough.length).toBeGreaterThan(0);
    }
  });

  it("bands every dimension insufficient when every group failed (null)", () => {
    const h = computeCompanyHealth({
      cash: null,
      delivery: null,
      safety: null,
      supplier: null,
      profitability: null,
    });
    for (const d of h.dimensions) expect(d.band).toBe("insufficient");
  });
});

// ---------------------------------------------------------------------------
// SAFETY — the critical honesty case
// ---------------------------------------------------------------------------

describe("safety dimension", () => {
  it("is INSUFFICIENT (never green) when there are no H&S records at all", () => {
    const input = { ...baseInput(), safety: { snapshot: snapshot(), hasAnySafetyRecord: false } };
    // An all-zero snapshot with no programme on record must not read as safe.
    expect(bandOf(input, "safety")).toBe("insufficient");
    expect(bandOf(input, "safety")).not.toBe("green");
  });

  it("is insufficient when the safety group failed to load", () => {
    expect(bandOf({ ...baseInput(), safety: null }, "safety")).toBe("insufficient");
  });

  it("is green only with a programme on record and zero exceptions", () => {
    const input = { ...baseInput(), safety: { snapshot: snapshot(), hasAnySafetyRecord: true } };
    expect(bandOf(input, "safety")).toBe("green");
  });

  it("is red on a live breach: an active job with no current RAMS", () => {
    const input = {
      ...baseInput(),
      safety: { snapshot: snapshot({ activeJobsNoCurrentRams: 1 }), hasAnySafetyRecord: true },
    };
    expect(bandOf(input, "safety")).toBe("red");
  });

  it("is red on a live breach: a permit expired but still open", () => {
    const input = {
      ...baseInput(),
      safety: { snapshot: snapshot({ permitsExpiredLive: 2 }), hasAnySafetyRecord: true },
    };
    expect(bandOf(input, "safety")).toBe("red");
  });

  it("is amber on a warning (draft RAMS) but no live breach", () => {
    const input = {
      ...baseInput(),
      safety: { snapshot: snapshot({ ramsDraft: 3 }), hasAnySafetyRecord: true },
    };
    expect(bandOf(input, "safety")).toBe("amber");
  });
});

// ---------------------------------------------------------------------------
// CASH & COMMERCIAL
// ---------------------------------------------------------------------------

describe("cash dimension", () => {
  it("is insufficient with nothing owed and no budgeted jobs", () => {
    const input = { ...baseInput(), cash: { agedDebt: agedDebt(), retention: retention(), cvr: cvr() } };
    expect(bandOf(input, "cash")).toBe("insufficient");
  });

  it("is red at exactly the 20% 90-day boundary", () => {
    const t = DEFAULT_HEALTH_THRESHOLDS.cash.over90SharePctRed;
    expect(t).toBe(20);
    const input = {
      ...baseInput(),
      cash: {
        agedDebt: agedDebt({ total: 1000, pastDue: 200, over90: 200 }),
        retention: retention(),
        cvr: cvr(),
      },
    };
    expect(bandOf(input, "cash")).toBe("red");
  });

  it("is red when a budgeted job is already forecast over budget", () => {
    const input = {
      ...baseInput(),
      cash: {
        agedDebt: agedDebt({ total: 1000 }),
        retention: retention(),
        cvr: cvr({ jobsWithBudget: 2, redCount: 1 }),
      },
    };
    expect(bandOf(input, "cash")).toBe("red");
  });

  it("is amber when some debt is past due but under the red line", () => {
    const input = {
      ...baseInput(),
      cash: {
        agedDebt: agedDebt({ total: 1000, pastDue: 150, over90: 100 }),
        retention: retention(),
        cvr: cvr(),
      },
    };
    expect(bandOf(input, "cash")).toBe("amber");
  });

  it("is green when everything owed is current and no budget is tight", () => {
    const input = {
      ...baseInput(),
      cash: { agedDebt: agedDebt({ total: 5000 }), retention: retention(), cvr: cvr({ jobsWithBudget: 3 }) },
    };
    expect(bandOf(input, "cash")).toBe("green");
  });
});

// ---------------------------------------------------------------------------
// DELIVERY & SCHEDULE
// ---------------------------------------------------------------------------

describe("delivery dimension", () => {
  it("is insufficient when no jobs are live", () => {
    const input = {
      ...baseInput(),
      delivery: { progress: progress(), programme: programme() },
    };
    expect(bandOf(input, "delivery")).toBe("insufficient");
  });

  it("is insufficient when live jobs exist but nothing is tracked", () => {
    const input = {
      ...baseInput(),
      delivery: {
        progress: progress({ activeJobs: 4, assessedJobs: 0 }),
        programme: programme({ jobsConsidered: 4, jobsWithBaseline: 0 }),
      },
    };
    expect(bandOf(input, "delivery")).toBe("insufficient");
  });

  it("is red at the 3-jobs-behind-baseline threshold", () => {
    expect(DEFAULT_HEALTH_THRESHOLDS.delivery.behindBaselineRed).toBe(3);
    const input = {
      ...baseInput(),
      delivery: {
        progress: progress({ activeJobs: 5, assessedJobs: 5 }),
        programme: programme({ jobsConsidered: 5, jobsWithBaseline: 5, behindBaseline: behindJobs(3) }),
      },
    };
    expect(bandOf(input, "delivery")).toBe("red");
  });

  it("is red at the 5-overdue-milestones threshold", () => {
    const input = {
      ...baseInput(),
      delivery: {
        progress: progress({ activeJobs: 5, assessedJobs: 5 }),
        programme: programme({ jobsConsidered: 5, jobsWithBaseline: 5, overdueMilestoneCount: 5 }),
      },
    };
    expect(bandOf(input, "delivery")).toBe("red");
  });

  it("is amber with one job behind baseline", () => {
    const input = {
      ...baseInput(),
      delivery: {
        progress: progress({ activeJobs: 5, assessedJobs: 5 }),
        programme: programme({ jobsConsidered: 5, jobsWithBaseline: 5, behindBaseline: behindJobs(1) }),
      },
    };
    expect(bandOf(input, "delivery")).toBe("amber");
  });

  it("is amber when a job has stalled", () => {
    const input = {
      ...baseInput(),
      delivery: {
        progress: progress({ activeJobs: 5, assessedJobs: 5, stalled: stalledJobs(1) }),
        programme: programme({ jobsConsidered: 5, jobsWithBaseline: 5 }),
      },
    };
    expect(bandOf(input, "delivery")).toBe("amber");
  });

  it("is green when nothing is behind, overdue, stalled or regressing", () => {
    const input = {
      ...baseInput(),
      delivery: {
        progress: progress({ activeJobs: 5, assessedJobs: 5 }),
        programme: programme({ jobsConsidered: 5, jobsWithBaseline: 5 }),
      },
    };
    expect(bandOf(input, "delivery")).toBe("green");
  });
});

// ---------------------------------------------------------------------------
// SUPPLIER
// ---------------------------------------------------------------------------

describe("supplier dimension", () => {
  it("is insufficient with no measurable supplier history", () => {
    expect(bandOf({ ...baseInput(), supplier: supplierRollup({ suppliersWithRecord: 0 }) }, "supplier")).toBe(
      "insufficient",
    );
  });

  it("is red at the 40% org-late boundary", () => {
    expect(DEFAULT_HEALTH_THRESHOLDS.supplier.orgLatePctRed).toBe(40);
    const input = {
      ...baseInput(),
      supplier: supplierRollup({ suppliersWithRecord: 4, orgPunctuality: ratio(4, 10) }),
    };
    expect(bandOf(input, "supplier")).toBe("red");
  });

  it("is red on any over-invoicing flag", () => {
    const input = {
      ...baseInput(),
      supplier: supplierRollup({
        suppliersWithRecord: 4,
        orgPunctuality: ratio(0, 10),
        overBillingFlags: overBillFlags(1),
      }),
    };
    expect(bandOf(input, "supplier")).toBe("red");
  });

  it("is amber at the 20% org-late boundary", () => {
    const input = {
      ...baseInput(),
      supplier: supplierRollup({ suppliersWithRecord: 4, orgPunctuality: ratio(2, 10) }),
    };
    expect(bandOf(input, "supplier")).toBe("amber");
  });

  it("is amber on a slow-settlement flag", () => {
    const input = {
      ...baseInput(),
      supplier: supplierRollup({
        suppliersWithRecord: 4,
        orgPunctuality: ratio(0, 10),
        slowSettlementFlags: slowFlags(1),
      }),
    };
    expect(bandOf(input, "supplier")).toBe("amber");
  });

  it("does not band on an UNRATED org rate (sample floor), staying green with no flags", () => {
    // ratio(2,3) has pct null — below MIN_RATED_SAMPLE, so it must not drive a band.
    const rate: Ratio = ratio(2, 3);
    expect(rate.pct).toBeNull();
    const input = {
      ...baseInput(),
      supplier: supplierRollup({ suppliersWithRecord: 1, orgPunctuality: rate }),
    };
    expect(bandOf(input, "supplier")).toBe("green");
  });
});

// ---------------------------------------------------------------------------
// PROFITABILITY
// ---------------------------------------------------------------------------

describe("profitability dimension", () => {
  it("is insufficient with no job carrying revenue", () => {
    expect(bandOf({ ...baseInput(), profitability: [profitRow(null)] }, "profitability")).toBe(
      "insufficient",
    );
    expect(bandOf({ ...baseInput(), profitability: [] }, "profitability")).toBe("insufficient");
    expect(bandOf({ ...baseInput(), profitability: null }, "profitability")).toBe("insufficient");
  });

  it("is red below the 15% margin line", () => {
    expect(DEFAULT_HEALTH_THRESHOLDS.profitability.redMarginPct).toBe(15);
    expect(bandOf({ ...baseInput(), profitability: [profitRow(14)] }, "profitability")).toBe("red");
  });

  it("is amber at exactly 15% and just under 30%", () => {
    expect(bandOf({ ...baseInput(), profitability: [profitRow(15)] }, "profitability")).toBe("amber");
    expect(bandOf({ ...baseInput(), profitability: [profitRow(29)] }, "profitability")).toBe("amber");
  });

  it("is green at exactly the 30% green line", () => {
    expect(DEFAULT_HEALTH_THRESHOLDS.profitability.greenMarginPct).toBe(30);
    expect(bandOf({ ...baseInput(), profitability: [profitRow(30)] }, "profitability")).toBe("green");
  });

  it("always prints the labour-exclusion caveat in its basis", () => {
    const dim = computeCompanyHealth({ ...baseInput(), profitability: [profitRow(40)] }).dimensions.find(
      (d) => d.key === "profitability",
    )!;
    expect(dim.basis.toLowerCase()).toContain("labour time not yet posted");
  });
});
