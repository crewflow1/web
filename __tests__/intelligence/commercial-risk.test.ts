import { describe, it, expect } from "vitest";
import {
  computeCommercialRiskBoard,
  commercialRiskMetric,
  COMMERCIAL_FACTOR_ORDER,
} from "@/lib/intelligence/commercial-risk";
import type { AgedDebtSummary, RetentionExposure } from "@/lib/intelligence/exposure";
import type { CustomerConcentration } from "@/lib/intelligence/concentration";
import type { CashTimeline } from "@/lib/intelligence/cash-timeline";

/**
 * COMMERCIAL RISK — independent factor board, NO composite grade.
 *
 * Pins: each factor banded by its own rule; absent input bands `insufficient`,
 * never `ok`; the four factors in fixed order; and no single overall grade on
 * the result (the anti-composite doctrine).
 */

const agedDebt = (over: Partial<AgedDebtSummary>): AgedDebtSummary => ({
  total: 0,
  pastDue: 0,
  over90: 0,
  d61to90: 0,
  undated: 0,
  debtorCount: 0,
  invoiceCount: 0,
  ...over,
});

const concentration = (over: Partial<CustomerConcentration>): CustomerConcentration =>
  ({
    window: { fromDay: "", toDay: "" },
    totalRevenue: 0,
    invoiceCount: 0,
    top: [],
    top1SharePct: null,
    top3SharePct: null,
    concentrated: null,
    flaggedBecause: null,
    ...over,
  }) as CustomerConcentration;

const retention = (over: Partial<RetentionExposure>): RetentionExposure => ({
  heldTotal: 0,
  notYetDue: 0,
  awaitingCompletion: 0,
  claimableNow: 0,
  jobsHolding: 0,
  jobsOverdue: 0,
  ...over,
});

const cash = (over: Partial<CashTimeline>): CashTimeline =>
  ({
    sufficient: true,
    todayKey: "2026-08-14",
    horizonWeeks: 13,
    weeks: [],
    totalInflow: 0,
    totalOutflow: 0,
    netMovement: 0,
    lowestCumulative: 0,
    lowestWeekIndex: 0,
    shortfall: false,
    overdueInflow: 0,
    overdueOutflow: 0,
    beyondHorizon: { inflow: 0, outflow: 0, count: 0 },
    undated: { inflow: 0, outflow: 0, items: [] },
    ...over,
  }) as CashTimeline;

describe("computeCommercialRiskBoard — banding each factor by its own rule", () => {
  const board = computeCommercialRiskBoard({
    agedDebt: agedDebt({ total: 10000, pastDue: 5000, over90: 3000 }), // 30% ≥ 20% → high
    concentration: concentration({ concentrated: true, top1SharePct: 55, invoiceCount: 12 }), // ≥ 40% → high
    retention: retention({ heldTotal: 4000, claimableNow: 900, jobsOverdue: 1 }), // overdue → high
    cash: cash({ shortfall: true, lowestCumulative: -2500, lowestWeekIndex: 4 }), // dip → high
  });

  it("bands aged debt high when 90+ debt crosses the share threshold", () => {
    const f = board.factors.find((x) => x.key === "aged_debt")!;
    expect(f.band).toBe("high");
    expect(f.detail).toMatch(/90\+ days/);
  });

  it("bands concentration high when one customer dominates", () => {
    expect(board.factors.find((x) => x.key === "concentration")!.band).toBe("high");
  });

  it("bands overdue retention high, and a cash dip high", () => {
    expect(board.factors.find((x) => x.key === "retention_overdue")!.band).toBe("high");
    expect(board.factors.find((x) => x.key === "cash_shortfall")!.band).toBe("high");
  });

  it("tallies the bands without blending them into a grade", () => {
    expect(board.highCount).toBe(4);
    expect(board.watchCount).toBe(0);
    expect(board.insufficientCount).toBe(0);
    expect(Object.keys(board).sort()).toEqual(
      ["factors", "highCount", "insufficientCount", "watchCount"].sort(),
    );
    expect(board).not.toHaveProperty("overallScore");
    expect(board).not.toHaveProperty("band");
  });

  it("returns the four factors in the fixed order with a heuristic metric", () => {
    expect(board.factors.map((f) => f.key)).toEqual([...COMMERCIAL_FACTOR_ORDER]);
    const m = commercialRiskMetric(board);
    expect(m.provenance.kind).toBe("heuristic");
    expect(m.provenance.basis).toMatch(/no single commercial-risk grade/i);
  });
});

describe("computeCommercialRiskBoard — ok / watch bands", () => {
  it("bands aged debt ok with no debt, watch with sub-threshold 90+ debt", () => {
    const none = computeCommercialRiskBoard({
      agedDebt: agedDebt({ total: 0 }),
      concentration: concentration({ concentrated: false, top1SharePct: 10, invoiceCount: 20 }),
      retention: retention({ heldTotal: 0 }),
      cash: cash({ shortfall: false, lowestCumulative: 500 }),
    });
    expect(none.factors.find((x) => x.key === "aged_debt")!.band).toBe("ok");
    expect(none.factors.find((x) => x.key === "concentration")!.band).toBe("ok");
    expect(none.highCount).toBe(0);

    const watch = computeCommercialRiskBoard({
      agedDebt: agedDebt({ total: 10000, pastDue: 1000, over90: 500 }), // 5% < 20% → watch
      concentration: concentration({ concentrated: null, invoiceCount: 2 }),
      retention: retention({ heldTotal: 2000, jobsOverdue: 0 }),
      cash: cash({ shortfall: false, lowestCumulative: 100 }),
    });
    expect(watch.factors.find((x) => x.key === "aged_debt")!.band).toBe("watch");
  });
});

describe("computeCommercialRiskBoard — insufficient (honesty path)", () => {
  it("bands every factor insufficient (never ok) when inputs are absent", () => {
    const board = computeCommercialRiskBoard({
      agedDebt: null,
      concentration: null,
      retention: null,
      cash: null,
    });
    expect(board.factors).toHaveLength(4);
    for (const f of board.factors) {
      expect(f.band).toBe("insufficient");
      expect(f.band).not.toBe("ok");
    }
    expect(board.insufficientCount).toBe(4);
    expect(board.highCount).toBe(0);
  });

  it("bands concentration insufficient below the sample floor, cash insufficient when the timeline is", () => {
    const board = computeCommercialRiskBoard({
      agedDebt: agedDebt({ total: 100 }),
      concentration: concentration({ concentrated: null, invoiceCount: 2 }),
      retention: retention({ heldTotal: 0 }),
      cash: cash({ sufficient: false }),
    });
    expect(board.factors.find((x) => x.key === "concentration")!.band).toBe("insufficient");
    expect(board.factors.find((x) => x.key === "cash_shortfall")!.band).toBe("insufficient");
  });
});
