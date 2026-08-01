import { describe, it, expect } from "vitest";
import {
  computeSubcontractorScoreboard,
  subcontractorReliabilityMetric,
  subcontractorRiskFlagsMetric,
} from "@/lib/health/subcontractor-score";
import {
  ratio,
  type DeliveryReliability,
  type PriceBehaviour,
  type SettlementSpeed,
  type SupplierPerformance,
} from "@/lib/suppliers/performance";

/**
 * SUBCONTRACTOR SCORING — exact values from fixtures. Ratios below the sample
 * floor are WITHHELD (never a rate the data hasn't earned); no composite score;
 * flags reuse the supplier-performance thresholds verbatim.
 */

function delivery(o: Partial<DeliveryReliability> = {}): DeliveryReliability {
  return {
    deliveries: 0,
    excluded: { voided: 0, draft: 0 },
    ordersDelivered: 0,
    punctuality: ratio(0, 0),
    onTime: 0,
    lateBands: { days1to3: 0, days4to7: 0, days8plus: 0 },
    deliveriesWithoutPromisedDate: 0,
    splitDeliveries: ratio(0, 0),
    ordersComplete: 0,
    ordersEndedShort: 0,
    ordersInProgress: 0,
    ...o,
  };
}

function price(o: Partial<PriceBehaviour> = {}): PriceBehaviour {
  return {
    overBilled: ratio(0, 0),
    atOrUnderOrder: 0,
    overBilledExcess: 0,
    partBilledOrders: 0,
    billsWithoutOrder: 0,
    ...o,
  };
}

function settlement(o: Partial<SettlementSpeed> = {}): SettlementSpeed {
  return {
    n: 0,
    bands: { within7: 0, within30: 0, within60: 0, over60: 0 },
    excludedNoBillDate: 0,
    unsettledBills: 0,
    ...o,
  };
}

function perf(
  id: string,
  o: { delivery?: DeliveryReliability; price?: PriceBehaviour; settlement?: SettlementSpeed; empty?: boolean },
): SupplierPerformance {
  return {
    supplierId: id,
    supplierName: `Sub ${id}`,
    delivery: o.delivery ?? delivery(),
    price: o.price ?? price(),
    settlement: o.settlement ?? settlement(),
    empty: o.empty ?? false,
  };
}

describe("computeSubcontractorScoreboard", () => {
  it("carries through rated ratios and WITHHOLDS sub-floor ones", () => {
    const board = computeSubcontractorScoreboard([
      // Rated: 10 judgeable deliveries, 3 late → 30%.
      perf("rated", {
        delivery: delivery({ deliveries: 10, punctuality: ratio(3, 10) }),
      }),
      // Sub-floor: 1 late of 2 → withheld (n < 5).
      perf("thin", {
        delivery: delivery({ deliveries: 2, punctuality: ratio(1, 2) }),
      }),
    ]);
    const rated = board.rows.find((r) => r.supplierId === "rated")!;
    const thin = board.rows.find((r) => r.supplierId === "thin")!;
    expect(rated.punctuality.pct).toBe(30);
    expect(thin.punctuality.pct).toBeNull();
    expect(board.withheldPunctuality).toBe(1);
    expect(board.subcontractorsWithRecord).toBe(2);
  });

  it("flags over-invoicing only above 20% and only when rated", () => {
    const board = computeSubcontractorScoreboard([
      perf("bad", { price: price({ overBilled: ratio(3, 10), overBilledExcess: 480 }) }), // 30% → flag
      perf("ok", { price: price({ overBilled: ratio(1, 10), overBilledExcess: 20 }) }), // 10% → no flag
      perf("thin", { price: price({ overBilled: ratio(1, 2), overBilledExcess: 50 }) }), // withheld → no flag
    ]);
    expect(board.overBillingFlags.map((r) => r.supplierId)).toEqual(["bad"]);
    expect(board.overBillingFlags[0]!.overBilledExcess).toBe(480);
    expect(board.withheldOverBilling).toBe(1);
  });

  it("flags slow settlement only above 25% and only when rated", () => {
    const board = computeSubcontractorScoreboard([
      // over60 = 4 of 10 settled = 40% → flag.
      perf("slow", { settlement: settlement({ n: 10, bands: { within7: 0, within30: 3, within60: 3, over60: 4 } }) }),
      // over60 = 1 of 10 = 10% → no flag.
      perf("fast", { settlement: settlement({ n: 10, bands: { within7: 5, within30: 4, within60: 0, over60: 1 } }) }),
    ]);
    expect(board.slowSettlementFlags.map((r) => r.supplierId)).toEqual(["slow"]);
    expect(board.slowSettlementFlags[0]!.slowSettlement.pct).toBe(40);
  });

  it("counts empty subcontractors apart, never as a record", () => {
    const board = computeSubcontractorScoreboard([
      perf("real", { delivery: delivery({ deliveries: 6, punctuality: ratio(0, 6) }) }),
      perf("never", { empty: true }),
    ]);
    expect(board.subcontractorsConsidered).toBe(2);
    expect(board.subcontractorsWithRecord).toBe(1);
    expect(board.subcontractorsEmpty).toBe(1);
    expect(board.rows.map((r) => r.supplierId)).toEqual(["real"]);
  });

  it("orders listed rows worst-punctuality first", () => {
    const board = computeSubcontractorScoreboard([
      perf("mild", { delivery: delivery({ deliveries: 10, punctuality: ratio(2, 10) }) }), // 20%
      perf("severe", { delivery: delivery({ deliveries: 10, punctuality: ratio(8, 10) }) }), // 80%
    ]);
    expect(board.rows.map((r) => r.supplierId)).toEqual(["severe", "mild"]);
  });

  it("emits DERIVED ratios and HEURISTIC flags, well-formed", () => {
    const board = computeSubcontractorScoreboard([]);
    expect(subcontractorReliabilityMetric(board).provenance.kind).toBe("derived");
    const flags = subcontractorRiskFlagsMetric(board);
    expect(flags.provenance.kind).toBe("heuristic");
    expect(flags.provenance.basis).toContain("%");
  });
});
