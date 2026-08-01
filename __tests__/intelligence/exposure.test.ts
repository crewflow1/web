import { describe, it, expect } from "vitest";
import { round2 } from "@/lib/money";
import type { RetentionRegisterTotals } from "@/lib/commercial/retention-register";
import type { AgeingTotals } from "@/lib/commercial/ageing";
import {
  agedDebtMetric,
  computeAgedDebtSummary,
  computeRetentionExposure,
  retentionExposureMetric,
} from "@/lib/intelligence/exposure";

/**
 * Exposure — a REGROUPING of two authorities' totals, so the test proves the
 * regrouping is exactly a partition: nothing invented, nothing dropped.
 */

const retentionTotals: RetentionRegisterTotals = {
  accrued: 10_000,
  released: 2_500,
  held: 7_500,
  outstandingByState: {
    overdue: 1_200,
    due: 800,
    held: 4_000,
    awaiting_completion: 1_500,
    released: 0,
  },
  lineCountByState: { overdue: 1, due: 1, held: 3, awaiting_completion: 2, released: 2 },
  jobCount: 5,
  jobsHoldingCount: 4,
  jobsOverdueCount: 1,
};

describe("retention exposure", () => {
  const e = computeRetentionExposure(retentionTotals);

  it("exposure = held (future-dated) + awaiting completion (undated)", () => {
    expect(e.notYetDue).toBe(5_500);
    expect(e.awaitingCompletion).toBe(1_500);
  });

  it("claimable now = overdue + due, via the register's own helper", () => {
    expect(e.claimableNow).toBe(2_000);
  });

  it("the regrouping partitions the register's held total exactly", () => {
    expect(round2(e.notYetDue + e.claimableNow)).toBe(retentionTotals.held);
    expect(e.heldTotal).toBe(retentionTotals.held);
  });

  it("carries the job counts through unchanged", () => {
    expect(e.jobsHolding).toBe(4);
    expect(e.jobsOverdue).toBe(1);
  });
});

const ageingTotals: AgeingTotals = {
  buckets: { current: 3_000, d1_30: 1_000, d31_60: 500, d61_90: 250, d91_plus: 750 },
  total: 5_500,
  pastDue: 2_500,
  itemCount: 12,
  partyCount: 4,
  undated: 400,
};

describe("aged debt summary", () => {
  const s = computeAgedDebtSummary(ageingTotals);

  it("restates the ledger's own bands without arithmetic", () => {
    expect(s.total).toBe(5_500);
    expect(s.pastDue).toBe(2_500);
    expect(s.over90).toBe(750);
    expect(s.d61to90).toBe(250);
    expect(s.undated).toBe(400);
    expect(s.debtorCount).toBe(4);
    expect(s.invoiceCount).toBe(12);
  });
});

describe("provenance", () => {
  it("both metrics are derived and link to their register surfaces", () => {
    const rm = retentionExposureMetric(computeRetentionExposure(retentionTotals));
    expect(rm.provenance.kind).toBe("derived");
    expect(rm.provenance.computedFrom[0]!.href).toBe("/reports/retention");

    const dm = agedDebtMetric(computeAgedDebtSummary(ageingTotals));
    expect(dm.provenance.kind).toBe("derived");
    expect(dm.provenance.computedFrom[0]!.href).toBe("/reports/ageing");
  });
});
