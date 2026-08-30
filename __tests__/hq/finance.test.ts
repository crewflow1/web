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
  // P12 sources — null here = unreadable this cycle, so the legacy estimate /
  // insufficient paths (pinned below) stay exercised by the BASE fixture.
  activeOrgMrrsGbp: null,
  activeOrgLtvsGbp: null,
  demoLifecycle: null,
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

describe("P12 — real MRR from per-org organizations.mrr_gbp", () => {
  it("MRR = sum of per-org mrr_gbp, per-org fallback to the £500 list price ONLY when null", () => {
    // 3 orgs: £750 + £400 contracted, one unrecorded → falls back to £500.
    const board = computeFinanceBoard(
      { ...BASE, activeCustomers: 3, activeOrgMrrsGbp: [750, null, 400] },
      NOW,
    );
    const m = metric(board, "mrr");
    expect(m.kind).toBe("derived");
    expect(m.value).toBe(1650); // 750 + 500 (fallback) + 400
    expect(m.basis).toMatch(/mrr_gbp/);
    expect(m.basis).toMatch(/1 without a recorded mrr_gbp.*£500/);
    // ARR follows the REAL figure.
    expect(metric(board, "arr").value).toBe(1650 * 12);
  });

  it("all per-org figures recorded → pure sum, no fallback wording", () => {
    const board = computeFinanceBoard(
      { ...BASE, activeCustomers: 2, activeOrgMrrsGbp: [600, 450] },
      NOW,
    );
    const m = metric(board, "mrr");
    expect(m.value).toBe(1050);
    expect(m.basis).not.toMatch(/without a recorded/);
  });

  it("per-org source unreadable (null) → the count × list-price ESTIMATE, labelled so", () => {
    const m = metric(computeFinanceBoard(BASE, NOW), "mrr"); // BASE has null source
    expect(m.value).toBe(4000); // 8 × 500 — the degraded estimate
    expect(m.basis).toMatch(/Estimate/);
    expect(m.basis).toMatch(/could not be read/);
  });
});

describe("P12 — LTV from cached per-org ltv_gbp", () => {
  it("total + average over orgs WITH a recorded value; unrecorded excluded, never £0", () => {
    const board = computeFinanceBoard(
      { ...BASE, activeCustomers: 4, activeOrgLtvsGbp: [12_000, null, 0, 6000] },
      NOW,
    );
    const total = metric(board, "ltv_total");
    const avg = metric(board, "ltv_avg");
    expect(total.kind).toBe("derived");
    expect(total.value).toBe(18_000); // null + 0 are UNRECORDED, not £0 values
    expect(avg.value).toBe(9000);
    expect(total.basis).toMatch(/2 orgs without a recorded value excluded/);
  });

  it("no org has a recorded LTV → insufficient (an unrecorded LTV is not £0)", () => {
    const board = computeFinanceBoard(
      { ...BASE, activeOrgLtvsGbp: [null, 0] },
      NOW,
    );
    expect(metric(board, "ltv_total").kind).toBe("insufficient");
    expect(metric(board, "ltv_avg").kind).toBe("insufficient");
    expect(metric(board, "ltv_total").basis).toMatch(/not £0/);
  });

  it("source unreadable → both LTV metrics insufficient", () => {
    const board = computeFinanceBoard(BASE, NOW);
    expect(metric(board, "ltv_total").kind).toBe("insufficient");
    expect(metric(board, "ltv_avg").kind).toBe("insufficient");
  });
});

describe("P12 — deterministic 3-month pipeline-weighted revenue forecast", () => {
  const DEMOS = {
    pendingDemo: 4,
    demoBooked: 2,
    approved: 6,
    rejected: 3,
    cancelled: 1,
  };

  it("forecast = 3 × (real MRR + winRate × pipeline × list price), basis showing the working", () => {
    // Real MRR = 1000 (two orgs). winRate = 6/10 = 0.6; pipeline = 6.
    // pipelineMrr = 0.6 × 6 × 500 = 1800 → forecast = 3 × (1000 + 1800) = 8400.
    const board = computeFinanceBoard(
      {
        ...BASE,
        activeCustomers: 2,
        activeOrgMrrsGbp: [600, 400],
        demoLifecycle: DEMOS,
      },
      NOW,
    );
    const m = metric(board, "revenue_forecast_3m");
    expect(m.kind).toBe("derived");
    expect(m.value).toBe(8400);
    expect(m.basis).toMatch(/60% historical demo win rate \(6 of 10 decided\)/);
    expect(m.basis).toMatch(/6 live pipeline requests/);
    expect(m.basis).toMatch(/upper-bound/i);
  });

  it("below the minimum decided-demo sample → honest insufficient, never a noisy rate", () => {
    const board = computeFinanceBoard(
      {
        ...BASE,
        demoLifecycle: { pendingDemo: 10, demoBooked: 5, approved: 2, rejected: 1, cancelled: 0 },
      },
      NOW,
    );
    const m = metric(board, "revenue_forecast_3m");
    expect(m.kind).toBe("insufficient");
    expect(m.value).toBeNull();
    expect(m.basis).toMatch(/minimum sample of 5/);
  });

  it("demo source unreadable → insufficient", () => {
    const m = metric(computeFinanceBoard(BASE, NOW), "revenue_forecast_3m");
    expect(m.kind).toBe("insufficient");
    expect(m.basis).toMatch(/could not be read/);
  });

  it("CAC STAYS insufficient — no acquisition-spend source exists (P12 does not fabricate one)", () => {
    const board = computeFinanceBoard(
      { ...BASE, activeOrgMrrsGbp: [500], demoLifecycle: DEMOS },
      NOW,
    );
    const m = metric(board, "cac");
    expect(m.kind).toBe("insufficient");
    expect(m.value).toBeNull();
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
