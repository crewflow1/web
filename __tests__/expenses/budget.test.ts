import { describe, it, expect } from "vitest";
import {
  computeExpenseBudgetPosition,
  spendDayKey,
  periodLabel,
  currentYearStartDayKey,
  poundsToPence,
  NEAR_THRESHOLD_PCT,
  OVER_THRESHOLD_PCT,
  type ExpenseBudgetRow,
  type ExpenseSpendRow,
  type CategoryBudgetLine,
} from "@/lib/expenses/budget";

/**
 * Expense budget-vs-actual — PURE domain proof.
 *
 * DETERMINISTIC: every case fixes `now` to a frozen instant and asserts EXACT
 * pence, variance, utilisation and band per category. The clock is never read.
 *
 * THE BST BOUNDARY is pinned deliberately: `now` is in August (British Summer
 * Time, UTC+1). A spend at 2026-07-31T23:30:00Z is 2026-08-01 00:30 in
 * Europe/London, so it belongs to AUGUST — a naive `toISOString().slice(0,7)`
 * would bucket it in July and drop it from the current month. The GMT year
 * boundary (December, UTC+0) is pinned too.
 */

// Frozen instant: 2026-08-15 10:00 UTC → 11:00 BST, London month 2026-08,
// quarter Q3, year 2026.
const NOW = new Date("2026-08-15T10:00:00.000Z");

const line = (lines: CategoryBudgetLine[], c: string) =>
  lines.find((l) => l.category === c)!;

describe("computeExpenseBudgetPosition — bands, variance, periods", () => {
  const budgets: ExpenseBudgetRow[] = [
    { category: "materials", amount_pence: 20000, period_type: "monthly", note: null, updated_at: null },
    { category: "fuel", amount_pence: 8000, period_type: "quarterly", note: null, updated_at: null },
    { category: "office", amount_pence: 50000, period_type: "annual", note: null, updated_at: null },
    { category: "tools", amount_pence: 30000, period_type: "monthly", note: null, updated_at: null },
  ];

  const spend: ExpenseSpendRow[] = [
    // materials, monthly = August 2026
    { category: "materials", amount: 150.0, bill_date: null, created_at: "2026-08-10T09:00:00.000Z" },
    // BST boundary: 23:30Z on 31 Jul → 00:30 BST 1 Aug → AUGUST.
    { category: "materials", amount: 100.0, bill_date: null, created_at: "2026-07-31T23:30:00.000Z" },
    // July → excluded from the August month.
    { category: "materials", amount: 999.0, bill_date: null, created_at: "2026-07-15T09:00:00.000Z" },
    // bill_date wins over a much-later created_at → August.
    { category: "materials", amount: 10.0, bill_date: "2026-08-02", created_at: "2026-11-01T00:00:00.000Z" },

    // fuel, quarterly = Q3 (Jul-Sep) 2026
    { category: "fuel", amount: 30.0, bill_date: null, created_at: "2026-07-05T09:00:00.000Z" },
    { category: "fuel", amount: 40.0, bill_date: null, created_at: "2026-08-10T09:00:00.000Z" },
    // Q2 → excluded from Q3.
    { category: "fuel", amount: 500.0, bill_date: null, created_at: "2026-04-01T09:00:00.000Z" },

    // office, annual = 2026
    { category: "office", amount: 200.0, bill_date: null, created_at: "2026-02-01T09:00:00.000Z" },
    { category: "office", amount: 100.0, bill_date: null, created_at: "2026-08-10T09:00:00.000Z" },
    // GMT year boundary: 23:30Z 31 Dec 2025 (GMT, +0) → still 2025 → excluded.
    { category: "office", amount: 999.0, bill_date: null, created_at: "2025-12-31T23:30:00.000Z" },

    // labor, NO budget → spend surfaced, not dropped (default monthly window).
    { category: "labor", amount: 75.0, bill_date: null, created_at: "2026-08-05T09:00:00.000Z" },

    // Unknown / null category → attributed to NO line and NO fabricated home.
    { category: null, amount: 1000.0, bill_date: null, created_at: "2026-08-05T09:00:00.000Z" },
    { category: "weird", amount: 1000.0, bill_date: null, created_at: "2026-08-05T09:00:00.000Z" },
  ];

  const result = computeExpenseBudgetPosition({ budgets, spend, now: NOW });

  it("materials is OVER — the BST-boundary and bill_date rows both count", () => {
    const m = line(result.lines, "materials");
    // 150 + 100 (BST 1 Aug) + 10 (bill_date Aug) = 260.00; the July 999 is out.
    expect(m.actualPence).toBe(26000);
    expect(m.budgetPence).toBe(20000);
    expect(m.variancePence).toBe(-6000);
    expect(m.utilisationPct).toBe(130);
    expect(m.band).toBe("over");
    expect(m.periodType).toBe("monthly");
    expect(m.periodLabel).toBe("August 2026");
  });

  it("fuel is NEAR — quarterly window includes July and August, excludes April", () => {
    const f = line(result.lines, "fuel");
    expect(f.actualPence).toBe(7000); // 30 + 40; the Q2 500 is out.
    expect(f.budgetPence).toBe(8000);
    expect(f.variancePence).toBe(1000);
    expect(f.utilisationPct).toBe(87.5); // > 80, ≤ 100 → near
    expect(f.band).toBe("near");
    expect(f.periodLabel).toBe("Q3 2026");
  });

  it("office is UNDER — annual window excludes the GMT-boundary 2025 row", () => {
    const o = line(result.lines, "office");
    expect(o.actualPence).toBe(30000); // 200 + 100; the 2025 999 is out.
    expect(o.variancePence).toBe(20000);
    expect(o.utilisationPct).toBe(60);
    expect(o.band).toBe("under");
    expect(o.periodLabel).toBe("2026");
  });

  it("no-SPEND category (tools) is under with a zero actual, not absent", () => {
    const t = line(result.lines, "tools");
    expect(t.hasBudget).toBe(true);
    expect(t.actualPence).toBe(0);
    expect(t.budgetPence).toBe(30000);
    expect(t.variancePence).toBe(30000);
    expect(t.utilisationPct).toBe(0);
    expect(t.band).toBe("under");
  });

  it("no-BUDGET category with spend is surfaced honestly, not a fake £0", () => {
    const l = line(result.lines, "labor");
    expect(l.hasBudget).toBe(false);
    expect(l.budgetPence).toBeNull();
    expect(l.variancePence).toBeNull();
    expect(l.utilisationPct).toBeNull();
    expect(l.actualPence).toBe(7500);
    expect(l.band).toBe("no_budget");
  });

  it("unknown / null-category spend is attributed to no line", () => {
    // Every line is a KNOWN category; none absorbs the null/"weird" £1000 rows.
    for (const l of result.lines) {
      expect(["materials", "fuel", "office", "tools", "labor", "subcontractor", "vehicle", "misc"])
        .toContain(l.category);
    }
    // vehicle/subcontractor/misc have neither budget nor spend → zeroed.
    for (const c of ["vehicle", "subcontractor", "misc"]) {
      const l = line(result.lines, c);
      expect(l.actualPence).toBe(0);
      expect(l.band).toBe("no_budget");
    }
  });

  it("always emits one line per known category, in the canonical order", () => {
    expect(result.lines.map((l) => l.category)).toEqual([
      "materials", "labor", "fuel", "subcontractor",
      "tools", "office", "vehicle", "misc",
    ]);
  });

  it("summary totals sum only budgeted categories; unbudgeted spend is separate", () => {
    expect(result.totalBudgetPence).toBe(108000); // 20000+8000+50000+30000
    expect(result.totalBudgetedActualPence).toBe(63000); // 26000+7000+30000+0
    expect(result.unbudgetedActualPence).toBe(7500); // labor only; null/weird excluded
    expect(result.mixedPeriods).toBe(true); // monthly + quarterly + annual
    expect(result.anyOver).toBe(true); // materials
  });
});

describe("empty and degenerate states", () => {
  it("no budgets and no spend → all lines no_budget, all zero", () => {
    const r = computeExpenseBudgetPosition({ budgets: [], spend: [], now: NOW });
    expect(r.lines).toHaveLength(8);
    for (const l of r.lines) {
      expect(l.hasBudget).toBe(false);
      expect(l.actualPence).toBe(0);
      expect(l.budgetPence).toBeNull();
      expect(l.variancePence).toBeNull();
      expect(l.band).toBe("no_budget");
    }
    expect(r.totalBudgetPence).toBe(0);
    expect(r.unbudgetedActualPence).toBe(0);
    expect(r.mixedPeriods).toBe(false);
    expect(r.anyOver).toBe(false);
  });

  it("a budget with no spend is under at 0% used", () => {
    const r = computeExpenseBudgetPosition({
      budgets: [
        { category: "misc", amount_pence: 5000, period_type: "monthly", note: null, updated_at: null },
      ],
      spend: [],
      now: NOW,
    });
    const m = line(r.lines, "misc");
    expect(m.utilisationPct).toBe(0);
    expect(m.band).toBe("under");
    expect(m.variancePence).toBe(5000);
    expect(r.mixedPeriods).toBe(false);
  });

  it("exactly at 100% used is NEAR, one penny over is OVER (thresholds pinned)", () => {
    const r = computeExpenseBudgetPosition({
      budgets: [
        { category: "materials", amount_pence: 10000, period_type: "monthly", note: null, updated_at: null },
      ],
      spend: [
        { category: "materials", amount: 100.0, bill_date: "2026-08-01", created_at: null },
      ],
      now: NOW,
    });
    const m = line(r.lines, "materials");
    expect(m.utilisationPct).toBe(100);
    expect(m.band).toBe("near"); // ≤ 100 is still near, not over

    const r2 = computeExpenseBudgetPosition({
      budgets: [
        { category: "materials", amount_pence: 10000, period_type: "monthly", note: null, updated_at: null },
      ],
      spend: [
        { category: "materials", amount: 100.01, bill_date: "2026-08-01", created_at: null },
      ],
      now: NOW,
    });
    expect(line(r2.lines, "materials").band).toBe("over");
  });
});

describe("pure helpers", () => {
  it("poundsToPence rounds to integer pence with no float drift", () => {
    expect(poundsToPence(100)).toBe(10000);
    expect(poundsToPence("19.99")).toBe(1999);
    expect(poundsToPence(0.1 + 0.2)).toBe(30); // 0.30000000000000004 → 30
    expect(poundsToPence(null)).toBe(0);
    expect(poundsToPence("nonsense")).toBe(0);
  });

  it("spendDayKey prefers bill_date, else London-pins created_at", () => {
    expect(spendDayKey({ category: "x", amount: 1, bill_date: "2026-08-02", created_at: "2026-11-01T00:00:00Z" }))
      .toBe("2026-08-02");
    // 23:30Z 31 Jul in BST → 1 Aug London.
    expect(spendDayKey({ category: "x", amount: 1, bill_date: null, created_at: "2026-07-31T23:30:00Z" }))
      .toBe("2026-08-01");
    expect(spendDayKey({ category: "x", amount: 1, bill_date: null, created_at: null })).toBe("");
  });

  it("periodLabel and currentYearStartDayKey are London-derived", () => {
    expect(periodLabel("2026-08-15", "monthly")).toBe("August 2026");
    expect(periodLabel("2026-08-15", "quarterly")).toBe("Q3 2026");
    expect(periodLabel("2026-08-15", "annual")).toBe("2026");
    expect(currentYearStartDayKey(NOW)).toBe("2026-01-01");
    // A GMT-boundary instant still lands in the right London year.
    expect(currentYearStartDayKey("2025-12-31T23:30:00Z")).toBe("2025-01-01");
  });

  it("thresholds are the documented values", () => {
    expect(NEAR_THRESHOLD_PCT).toBe(80);
    expect(OVER_THRESHOLD_PCT).toBe(100);
  });
});
