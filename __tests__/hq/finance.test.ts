import { describe, it, expect } from "vitest";
import {
  computeFinanceBoard,
  FINANCE_KIND_LABEL,
  type FinanceInput,
  type FinanceMetric,
} from "@/lib/hq/finance";

/**
 * HQ Finance AI — pure board compute contract.
 *
 * Pins:
 *   1. Deterministic maths: MRR / ARR / active subs / new / churned are exact
 *      from fixtures, and the same inputs + `now` always give the same board.
 *   2. The honesty invariant: a metric whose input source does NOT exist
 *      returns `insufficient` with a stated basis and value === null — never a
 *      fabricated 0-as-real. When a real source is supplied, the SAME code
 *      computes a real value.
 *   3. Every figure carries a label and a non-empty basis.
 */

// A representative HQ input: 8 active, 3 trials, 2 new, 1 churned, £500/mo, and
// NONE of the four absent sources (the schema has nowhere to read them today).
const BASE: FinanceInput = {
  activeCustomers: 8,
  trials: 3,
  newCustomersThisMonth: 2,
  churnedThisMonth: 1,
  monthlyPriceGbp: 500,
  costOfRevenueGbp: null,
  cashCollectedGbp: null,
  cashBalanceGbp: null,
  monthlyBurnGbp: null,
  acquisitionSpendGbp: null,
};

const NOW = new Date("2026-08-01T09:00:00.000Z");

function metric(board: { metrics: FinanceMetric[] }, key: string): FinanceMetric {
  const m = board.metrics.find((x) => x.key === key);
  if (!m) throw new Error(`metric ${key} missing from board`);
  return m;
}

describe("computeFinanceBoard — deterministic maths", () => {
  it("MRR = active × contracted price, labelled derived", () => {
    const m = metric(computeFinanceBoard(BASE, NOW), "mrr");
    expect(m.value).toBe(4000); // 8 × 500
    expect(m.kind).toBe("derived");
  });

  it("ARR = MRR × 12, labelled derived", () => {
    const m = metric(computeFinanceBoard(BASE, NOW), "arr");
    expect(m.value).toBe(48_000); // 4000 × 12
    expect(m.kind).toBe("derived");
  });

  it("active subscriptions / trials / new / churned are exact facts", () => {
    const board = computeFinanceBoard(BASE, NOW);
    expect(metric(board, "active_subscriptions").value).toBe(8);
    expect(metric(board, "trials").value).toBe(3);
    expect(metric(board, "new_this_period").value).toBe(2);
    expect(metric(board, "churned_this_period").value).toBe(1);
    for (const key of ["active_subscriptions", "trials", "new_this_period", "churned_this_period"]) {
      expect(metric(board, key).kind).toBe("fact");
    }
  });

  it("is a pure function of (input, now) — identical inputs give an identical board", () => {
    expect(computeFinanceBoard(BASE, NOW)).toEqual(computeFinanceBoard(BASE, NOW));
  });

  it("stamps asOf + period label from the injected now (no wall clock)", () => {
    const board = computeFinanceBoard(BASE, NOW);
    expect(board.asOf).toBe("2026-08-01T09:00:00.000Z");
    expect(board.periodLabel).toBe("August 2026");
  });

  it("zero active customers → £0 MRR and ARR (honest zero from a real count, still derived)", () => {
    const board = computeFinanceBoard({ ...BASE, activeCustomers: 0 }, NOW);
    expect(metric(board, "mrr").value).toBe(0);
    expect(metric(board, "arr").value).toBe(0);
    expect(metric(board, "mrr").kind).toBe("derived");
  });
});

describe("computeFinanceBoard — insufficient-data honesty (never a fabricated 0)", () => {
  const board = computeFinanceBoard(BASE, NOW);

  it("gross margin is insufficient with no cost-of-revenue source — value is null, not 0", () => {
    const m = metric(board, "gross_margin");
    expect(m.kind).toBe("insufficient");
    expect(m.value).toBeNull();
    expect(m.value).not.toBe(0);
    expect(m.basis).toMatch(/cost of revenue|COGS/i);
  });

  it("cash in is insufficient with no payment feed — MRR is NOT passed off as cash", () => {
    const m = metric(board, "cash_in");
    expect(m.kind).toBe("insufficient");
    expect(m.value).toBeNull();
    expect(m.basis).toMatch(/not cash received|payment/i);
  });

  it("runway is insufficient with no burn source", () => {
    const m = metric(board, "runway");
    expect(m.kind).toBe("insufficient");
    expect(m.value).toBeNull();
    expect(m.basis).toMatch(/burn/i);
  });

  it("CAC is insufficient with no acquisition-spend source", () => {
    const m = metric(board, "cac");
    expect(m.kind).toBe("insufficient");
    expect(m.value).toBeNull();
    expect(m.basis).toMatch(/spend/i);
  });
});

describe("computeFinanceBoard — SAME code computes real figures once a source lands", () => {
  it("supplying costOfRevenue turns gross margin into a real derived percentage", () => {
    // MRR = 4000, cost = 1000 → margin = 75%
    const board = computeFinanceBoard({ ...BASE, costOfRevenueGbp: 1000 }, NOW);
    const m = metric(board, "gross_margin");
    expect(m.kind).toBe("derived");
    expect(m.value).toBe(75);
  });

  it("supplying cash BALANCE + burn turns runway into a real derived figure", () => {
    // balance 12000 ÷ burn 3000 = 4 months. Runway reads the BALANCE numerator,
    // not period inflow.
    const board = computeFinanceBoard(
      { ...BASE, cashBalanceGbp: 12_000, monthlyBurnGbp: 3000 },
      NOW,
    );
    const runway = metric(board, "runway");
    expect(runway.kind).toBe("derived");
    expect(runway.value).toBe(4);
  });

  it("runway uses the cash BALANCE, never period inflow: cashCollected + burn stays insufficient", () => {
    // Period inflow ≠ balance. With a burn but no balance source, runway must
    // NOT be computed from cashCollected — it stays insufficient. (cash_in,
    // which IS period inflow, still becomes a real fact.)
    const board = computeFinanceBoard(
      { ...BASE, cashCollectedGbp: 12_000, monthlyBurnGbp: 3000 },
      NOW,
    );
    const cash = metric(board, "cash_in");
    const runway = metric(board, "runway");
    expect(cash.kind).toBe("fact");
    expect(cash.value).toBe(12_000);
    expect(runway.kind).toBe("insufficient");
    expect(runway.value).toBeNull();
  });

  it("supplying acquisition spend turns CAC into a real derived figure", () => {
    // spend 3000 ÷ 2 new = 1500
    const board = computeFinanceBoard({ ...BASE, acquisitionSpendGbp: 3000 }, NOW);
    const m = metric(board, "cac");
    expect(m.kind).toBe("derived");
    expect(m.value).toBe(1500);
  });

  it("guards divide-by-zero: cost source present but MRR 0 stays insufficient, not NaN", () => {
    const board = computeFinanceBoard(
      { ...BASE, activeCustomers: 0, costOfRevenueGbp: 500 },
      NOW,
    );
    expect(metric(board, "gross_margin").kind).toBe("insufficient");
  });
});

describe("computeFinanceBoard — every metric self-labels", () => {
  it("has a label word for every kind and a non-empty basis on every metric", () => {
    const board = computeFinanceBoard(BASE, NOW);
    expect(Object.keys(FINANCE_KIND_LABEL).sort()).toEqual([
      "derived",
      "fact",
      "insufficient",
    ]);
    for (const m of board.metrics) {
      expect(m.basis.trim().length).toBeGreaterThan(0);
      expect(["fact", "derived", "insufficient"]).toContain(m.kind);
      // The value/kind invariant: null iff insufficient.
      if (m.kind === "insufficient") expect(m.value).toBeNull();
      else expect(typeof m.value).toBe("number");
    }
  });
});
