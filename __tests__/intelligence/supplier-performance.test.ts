import { describe, it, expect } from "vitest";
import {
  ratio,
  type DeliveryReliability,
  type PriceBehaviour,
  type SettlementSpeed,
  type SupplierPerformance,
} from "@/lib/suppliers/performance";
import {
  SUPPLIER_OVERBILL_FLAG_PCT,
  SUPPLIER_SLOW_SETTLEMENT_PCT,
  computeSupplierPerformanceRollup,
  supplierReliabilityMetric,
  supplierRiskFlagsMetric,
} from "@/lib/intelligence/supplier-performance";

/**
 * SUPPLIER PERFORMANCE ROLLUP — the org-wide compose over the shipped
 * measurement. Pure fixtures → exact rollup numbers; the sample floor withholds
 * a thin record from every ranking; every metric labels itself; and the result
 * is independent of the order the suppliers arrive in.
 *
 * The fixtures build real `SupplierPerformance` shapes and use the LIB's own
 * `ratio()` for every rate, so the MIN_RATED_SAMPLE floor is exercised exactly
 * as production would apply it — the rollup is never handed a percentage the
 * sample has not earned.
 */

// ---------------------------------------------------------------------------
// Fixture factory — full SupplierPerformance shapes, lib ratios throughout
// ---------------------------------------------------------------------------

function delivery(deliveries: number, late: number, judgeable: number): DeliveryReliability {
  return {
    deliveries,
    excluded: { voided: 0, draft: 0 },
    ordersDelivered: deliveries,
    punctuality: ratio(late, judgeable),
    onTime: Math.max(0, judgeable - late),
    lateBands: { days1to3: late, days4to7: 0, days8plus: 0 },
    deliveriesWithoutPromisedDate: 0,
    splitDeliveries: ratio(0, deliveries),
    ordersComplete: deliveries,
    ordersEndedShort: 0,
    ordersInProgress: 0,
  };
}

function price(overCount: number, overN: number, excess: number): PriceBehaviour {
  return {
    overBilled: ratio(overCount, overN),
    atOrUnderOrder: Math.max(0, overN - overCount),
    overBilledExcess: excess,
    partBilledOrders: 0,
    billsWithoutOrder: 0,
  };
}

function settlement(n: number, over60: number): SettlementSpeed {
  return {
    n,
    bands: { within7: Math.max(0, n - over60), within30: 0, within60: 0, over60 },
    excludedNoBillDate: 0,
    unsettledBills: 0,
  };
}

function perf(over: {
  id: string;
  name: string;
  delivery?: DeliveryReliability;
  price?: PriceBehaviour;
  settlement?: SettlementSpeed;
  empty?: boolean;
}): SupplierPerformance {
  return {
    supplierId: over.id,
    supplierName: over.name,
    delivery: over.delivery ?? delivery(0, 0, 0),
    price: over.price ?? price(0, 0, 0),
    settlement: over.settlement ?? settlement(0, 0),
    empty: over.empty ?? false,
  };
}

// S1 Alpha: reliable, clean, fast. S2 Bravo: late, over-invoices, settled slow.
// S3 Charlie: too little history to rate anything. S4 Delta: never traded.
const ALPHA = perf({
  id: "s-alpha",
  name: "Alpha Supplies",
  delivery: delivery(10, 1, 10), // 10% late, rated
  price: price(0, 6, 0),
  settlement: settlement(8, 0),
});
const BRAVO = perf({
  id: "s-bravo",
  name: "Bravo Merchants",
  delivery: delivery(10, 5, 10), // 50% late, rated
  price: price(3, 10, 150), // 30% over-billed → over the flag threshold
  settlement: settlement(8, 4), // 50% over 60 days → over the slow threshold
});
const CHARLIE = perf({
  id: "s-charlie",
  name: "Charlie Trade",
  delivery: delivery(2, 2, 2), // n=2 → withheld
  price: price(1, 2, 50), // n=2 → withheld
  settlement: settlement(2, 1), // n=2 → withheld
});
const DELTA = perf({ id: "s-delta", name: "Delta Ltd", empty: true });

const ALL = [ALPHA, BRAVO, CHARLIE, DELTA];

// ---------------------------------------------------------------------------
// Exact numbers
// ---------------------------------------------------------------------------

describe("rollup — exact aggregate numbers", () => {
  const r = computeSupplierPerformanceRollup(ALL);

  it("counts considered / with-record / empty suppliers", () => {
    expect(r.suppliersConsidered).toBe(4);
    expect(r.suppliersWithRecord).toBe(3);
    expect(r.suppliersEmpty).toBe(1);
  });

  it("org punctuality sums late over judgeable across suppliers (8 of 22 → 36%)", () => {
    expect(r.orgPunctuality.count).toBe(8);
    expect(r.orgPunctuality.n).toBe(22);
    expect(r.orgPunctuality.pct).toBe(36);
  });

  it("over-billed excess totals across every supplier (£150 + £50)", () => {
    expect(r.overBilledExcessTotal).toBe(200);
  });
});

describe("rankings — lowest/highest late rate, rated suppliers only", () => {
  const r = computeSupplierPerformanceRollup(ALL);

  it("most reliable is lowest late-rate first", () => {
    expect(r.mostReliable.map((s) => s.supplierId)).toEqual(["s-alpha", "s-bravo"]);
  });

  it("least reliable is highest late-rate first", () => {
    expect(r.leastReliable.map((s) => s.supplierId)).toEqual(["s-bravo", "s-alpha"]);
  });

  it("slowest-settling is highest over-60-day share first", () => {
    expect(r.slowestSettling.map((s) => s.supplierId)).toEqual(["s-bravo", "s-alpha"]);
  });
});

describe("heuristic flags — thresholds applied to rated samples only", () => {
  const r = computeSupplierPerformanceRollup(ALL);

  it("over-invoicing flag fires above the stated percentage", () => {
    expect(r.overBillingFlags.map((s) => s.supplierId)).toEqual(["s-bravo"]);
    expect(r.overBillingFlags[0]!.overBilled.pct).toBeGreaterThan(SUPPLIER_OVERBILL_FLAG_PCT);
    expect(r.overBillingFlags[0]!.overBilledExcess).toBe(150);
  });

  it("slow-settlement flag fires above the stated percentage", () => {
    expect(r.slowSettlementFlags.map((s) => s.supplierId)).toEqual(["s-bravo"]);
    expect(r.slowSettlementFlags[0]!.slowShare.pct).toBeGreaterThan(SUPPLIER_SLOW_SETTLEMENT_PCT);
  });
});

describe("sample floor — a thin record is withheld, never ranked", () => {
  const r = computeSupplierPerformanceRollup(ALL);

  it("Charlie (n=2 everywhere) is in no ranking and no flag list", () => {
    const ranked = [
      ...r.mostReliable,
      ...r.leastReliable,
      ...r.slowestSettling,
      ...r.overBillingFlags,
      ...r.slowSettlementFlags,
    ].map((s) => s.supplierId);
    expect(ranked).not.toContain("s-charlie");
  });

  it("Charlie is counted in every withheld tally", () => {
    expect(r.withheldDeliveryRating).toBe(1);
    expect(r.withheldSettlementRating).toBe(1);
    expect(r.withheldPriceRating).toBe(1);
  });

  it("an all-thin roster rates nothing and ranks nothing", () => {
    const r2 = computeSupplierPerformanceRollup([CHARLIE]);
    expect(r2.orgPunctuality.pct).toBeNull(); // n=2 < 5
    expect(r2.mostReliable).toEqual([]);
    expect(r2.leastReliable).toEqual([]);
    expect(r2.overBillingFlags).toEqual([]);
    expect(r2.withheldDeliveryRating).toBe(1);
  });

  it("an empty roster is all zeroes, not an error", () => {
    const r3 = computeSupplierPerformanceRollup([]);
    expect(r3.suppliersConsidered).toBe(0);
    expect(r3.suppliersWithRecord).toBe(0);
    expect(r3.orgPunctuality.n).toBe(0);
    expect(r3.overBilledExcessTotal).toBe(0);
  });
});

describe("permutation independence — the rollup does not depend on input order", () => {
  const base = computeSupplierPerformanceRollup(ALL);
  const shuffles = [
    [DELTA, CHARLIE, BRAVO, ALPHA],
    [BRAVO, DELTA, ALPHA, CHARLIE],
    [CHARLIE, ALPHA, DELTA, BRAVO],
  ];

  for (const [i, order] of shuffles.entries()) {
    it(`permutation ${i} yields identical rankings and counts`, () => {
      const r = computeSupplierPerformanceRollup(order);
      expect(r.suppliersWithRecord).toBe(base.suppliersWithRecord);
      expect(r.orgPunctuality).toEqual(base.orgPunctuality);
      expect(r.overBilledExcessTotal).toBe(base.overBilledExcessTotal);
      expect(r.mostReliable.map((s) => s.supplierId)).toEqual(
        base.mostReliable.map((s) => s.supplierId),
      );
      expect(r.leastReliable.map((s) => s.supplierId)).toEqual(
        base.leastReliable.map((s) => s.supplierId),
      );
      expect(r.slowestSettling.map((s) => s.supplierId)).toEqual(
        base.slowestSettling.map((s) => s.supplierId),
      );
      expect(r.overBillingFlags.map((s) => s.supplierId)).toEqual(
        base.overBillingFlags.map((s) => s.supplierId),
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Provenance — every metric labels itself; the flag states its thresholds
// ---------------------------------------------------------------------------

describe("provenance completeness", () => {
  const r = computeSupplierPerformanceRollup(ALL);

  it("reliability is DERIVED with evidence links to the supplier surfaces", () => {
    const m = supplierReliabilityMetric(r);
    expect(m.provenance.kind).toBe("derived");
    expect(m.provenance.basis.trim().length).toBeGreaterThan(20);
    const hrefs = m.provenance.computedFrom.map((c) => c.href);
    expect(hrefs).toContain("/suppliers/compare");
    expect(hrefs).toContain("/suppliers");
    expect(m.provenance.sampleFloorApplied).toBe(true); // Charlie is withheld
  });

  it("risk flags are HEURISTIC with both thresholds stated verbatim", () => {
    const m = supplierRiskFlagsMetric(r);
    expect(m.provenance.kind).toBe("heuristic");
    expect(m.provenance.basis).toContain(`${SUPPLIER_OVERBILL_FLAG_PCT}%`);
    expect(m.provenance.basis).toContain(`${SUPPLIER_SLOW_SETTLEMENT_PCT}%`);
    expect(m.provenance.basis).toContain("60 days");
    expect(m.provenance.computedFrom.length).toBeGreaterThan(0);
  });

  it("the rollup exposes no composite / blended score field", () => {
    for (const key of Object.keys(r)) {
      expect(key).not.toMatch(/overallScore|healthScore|compositeScore|weightedScore/);
    }
  });
});

describe("evidence links point at the shipped per-supplier surface", () => {
  it("every ranked row deep-links to /suppliers/[id]/performance", () => {
    const r = computeSupplierPerformanceRollup(ALL);
    for (const row of [...r.mostReliable, ...r.slowestSettling, ...r.overBillingFlags]) {
      expect(row.href).toBe(`/suppliers/${row.supplierId}/performance`);
    }
  });
});
