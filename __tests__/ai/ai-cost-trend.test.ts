import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_COST_TREND_MONTHS,
  composeAiCostTrend,
  type AiCostFeatureRow,
} from "@/server/services/ai-cost-snapshot";
import { ukMonthKeyOf } from "@/lib/ai/governor/policy";

/**
 * The HQ AI-cost TREND — the PURE composition over the monthly rollups.
 *
 * The read that fetches the SQL rollups is exercised elsewhere; what matters
 * here is the shape of the series it produces, because that is where the two
 * failure modes live:
 *
 *   1. THE MONTH BUCKET. The window and every figure hang off Europe/London
 *      budget months. A row at 00:30 on 1 August BST has a UTC timestamp still
 *      reading 31 July, so bucketing by the UTC month would spend August's
 *      money out of July — the exact error the governor's month helper exists to
 *      prevent. Proven with a FROZEN BST instant, never `now()`.
 *
 *   2. THE EMPTY SERIES. While the governor is dark every rollup is empty, so
 *      the composition must return an honest run of zeros — not crash, and not
 *      invent a line.
 */

/** A ledger row, as it would arrive before the London-month rollup folds it. */
type LedgerRow = { createdAt: string; costPence: number };

/**
 * Fold raw ledger rows into per-month committed totals THE WAY THE GOVERNOR
 * DOES — keyed by `ukMonthKeyOf`, the Europe/London month helper, and never by
 * `toISOString` month maths. This mirrors, in TypeScript, what the SQL rollup
 * does with `at time zone 'Europe/London'`, so the boundary can be asserted
 * with a frozen instant.
 */
function foldRowsToUkMonths(
  rows: ReadonlyArray<LedgerRow>,
): Map<string, { totalPence: number; invocations: number }> {
  const out = new Map<string, { totalPence: number; invocations: number }>();
  for (const r of rows) {
    const key = ukMonthKeyOf(r.createdAt);
    const cur = out.get(key) ?? { totalPence: 0, invocations: 0 };
    cur.totalPence += r.costPence;
    cur.invocations += 1;
    out.set(key, cur);
  }
  return out;
}

afterEach(() => {
  vi.useRealTimers();
});

// =====================================================================
// 1. The window is the Europe/London months ENDING on asOfMonth.
// =====================================================================

describe("the trend window is London months, oldest → newest", () => {
  it("defaults to a full year, ending on the anchor month", () => {
    const trend = composeAiCostTrend({ asOfMonth: "2026-08", monthTotals: new Map() });
    expect(AI_COST_TREND_MONTHS).toBe(12);
    expect(trend.windowMonths).toBe(12);
    expect(trend.months).toHaveLength(12);
    // Oldest first, newest last; the anchor is the newest.
    expect(trend.months[0]!.month).toBe("2025-09");
    expect(trend.months[11]!.month).toBe("2026-08");
    expect(trend.asOfMonth).toBe("2026-08");
  });

  it("flags ONLY the anchor month as current", () => {
    const trend = composeAiCostTrend({ asOfMonth: "2026-08", monthTotals: new Map() });
    const current = trend.months.filter((m) => m.isCurrent);
    expect(current).toHaveLength(1);
    expect(current[0]!.month).toBe("2026-08");
  });

  it("honours a custom, smaller window", () => {
    const trend = composeAiCostTrend({
      asOfMonth: "2026-03",
      windowMonths: 3,
      monthTotals: new Map(),
    });
    expect(trend.months.map((m) => m.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
  });

  it("crosses a year boundary correctly (Jan window reaches back into the prior year)", () => {
    const trend = composeAiCostTrend({
      asOfMonth: "2026-01",
      windowMonths: 3,
      monthTotals: new Map(),
    });
    expect(trend.months.map((m) => m.month)).toEqual(["2025-11", "2025-12", "2026-01"]);
  });

  it("does NOT read the clock — the window is anchored on asOfMonth, not now()", () => {
    // If the composition ever fell back to `now()` for its anchor this frozen,
    // deliberately-wrong system time would leak into the result.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-12-31T12:00:00Z"));
    const trend = composeAiCostTrend({
      asOfMonth: "2026-08",
      windowMonths: 2,
      monthTotals: new Map(),
      generatedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(trend.months.map((m) => m.month)).toEqual(["2026-07", "2026-08"]);
    expect(trend.generatedAt).toBe("2026-08-01T00:00:00.000Z");
  });
});

// =====================================================================
// 2. The month bucket is Europe/London, proven at the BST boundary.
// =====================================================================

describe("ledger rows bucket into Europe/London months, not UTC", () => {
  it("a row at 00:30 on 1 August BST lands in AUGUST, not July", () => {
    // 00:30 on 1 Aug London (BST, UTC+1) is 23:30 on 31 Jul in UTC. Bucketing
    // by the UTC month would put August's first call in July's budget.
    const boundaryInstant = "2026-07-31T23:30:00.000Z";
    expect(ukMonthKeyOf(boundaryInstant)).toBe("2026-08");

    const totals = foldRowsToUkMonths([
      { createdAt: boundaryInstant, costPence: 500 }, // London August
      { createdAt: "2026-07-20T12:00:00.000Z", costPence: 300 }, // clearly July
    ]);

    const trend = composeAiCostTrend({ asOfMonth: "2026-08", monthTotals: totals });
    const july = trend.months.find((m) => m.month === "2026-07")!;
    const august = trend.months.find((m) => m.month === "2026-08")!;
    expect(july.totalPence).toBe(300);
    expect(august.totalPence).toBe(500);
    expect(august.invocations).toBe(1);
  });

  it("folds multiple rows in one London month into a single bucket", () => {
    const totals = foldRowsToUkMonths([
      { createdAt: "2026-05-02T09:00:00.000Z", costPence: 120 },
      { createdAt: "2026-05-28T17:00:00.000Z", costPence: 80 },
    ]);
    const trend = composeAiCostTrend({ asOfMonth: "2026-05", windowMonths: 1, monthTotals: totals });
    expect(trend.months).toHaveLength(1);
    expect(trend.months[0]!.totalPence).toBe(200);
    expect(trend.months[0]!.invocations).toBe(2);
  });

  it("labels a month from its key without re-bucketing it", () => {
    const trend = composeAiCostTrend({ asOfMonth: "2026-08", windowMonths: 1, monthTotals: new Map() });
    expect(trend.months[0]!.label).toBe("Aug 2026");
  });
});

// =====================================================================
// 3. The empty series — the dark build's honest zero.
// =====================================================================

describe("an empty ledger yields an honest zero series, never a crash", () => {
  it("returns a full window of zeros with hasAnySpend false", () => {
    const trend = composeAiCostTrend({ asOfMonth: "2026-08", monthTotals: new Map() });
    expect(trend.months).toHaveLength(12);
    expect(trend.months.every((m) => m.totalPence === 0 && m.invocations === 0)).toBe(true);
    expect(trend.totalPence).toBe(0);
    expect(trend.peakPence).toBe(0);
    expect(trend.peakMonth).toBeNull();
    expect(trend.monthsWithSpend).toBe(0);
    expect(trend.hasAnySpend).toBe(false);
    expect(trend.byFeature).toEqual([]);
  });

  it("the oldest month's delta is null; the rest are zero on a flat zero series", () => {
    const trend = composeAiCostTrend({ asOfMonth: "2026-08", monthTotals: new Map() });
    expect(trend.months[0]!.deltaPence).toBeNull();
    expect(trend.months.slice(1).every((m) => m.deltaPence === 0)).toBe(true);
  });

  it("tolerates a malformed anchor without throwing", () => {
    const trend = composeAiCostTrend({ asOfMonth: "not-a-month", monthTotals: new Map() });
    expect(trend.hasAnySpend).toBe(false);
    expect(trend.months.length).toBeGreaterThanOrEqual(1);
  });
});

// =====================================================================
// 4. Deltas, peak and totals over a populated window.
// =====================================================================

describe("month-over-month deltas, peak and window total", () => {
  const totals = new Map<string, { totalPence: number; invocations: number }>([
    ["2026-06", { totalPence: 1000, invocations: 10 }],
    ["2026-07", { totalPence: 1500, invocations: 12 }],
    ["2026-08", { totalPence: 900, invocations: 8 }],
  ]);

  it("delta is null for the oldest, then the signed change against the prior month", () => {
    const trend = composeAiCostTrend({ asOfMonth: "2026-08", windowMonths: 3, monthTotals: totals });
    expect(trend.months.map((m) => m.deltaPence)).toEqual([null, 500, -600]);
  });

  it("delta compares against the WINDOW-adjacent month, even when the ledger is silent between", () => {
    // A zero-filled gap month resets the comparison to zero, so a resumption
    // reads as the full jump it is.
    const sparse = new Map<string, { totalPence: number; invocations: number }>([
      ["2026-06", { totalPence: 1000, invocations: 5 }],
      ["2026-08", { totalPence: 400, invocations: 2 }],
    ]);
    const trend = composeAiCostTrend({ asOfMonth: "2026-08", windowMonths: 3, monthTotals: sparse });
    // 2026-07 is a zero-filled gap: delta = 0 - 1000 = -1000; 2026-08 = 400 - 0.
    expect(trend.months.map((m) => m.totalPence)).toEqual([1000, 0, 400]);
    expect(trend.months.map((m) => m.deltaPence)).toEqual([null, -1000, 400]);
  });

  it("reports the peak month and the window total", () => {
    const trend = composeAiCostTrend({ asOfMonth: "2026-08", windowMonths: 3, monthTotals: totals });
    expect(trend.peakPence).toBe(1500);
    expect(trend.peakMonth).toBe("2026-07");
    expect(trend.totalPence).toBe(3400);
    expect(trend.monthsWithSpend).toBe(3);
    expect(trend.hasAnySpend).toBe(true);
  });
});

// =====================================================================
// 5. Per-feature contribution is passed through, most expensive first.
// =====================================================================

describe("per-feature contribution over the window", () => {
  it("preserves the caller's ordering and rows verbatim", () => {
    const byFeature: AiCostFeatureRow[] = [
      { feature: "b.two", label: "Two", spentPence: 900, invocations: 3, failures: 0 },
      { feature: "a.one", label: "One", spentPence: 100, invocations: 1, failures: 0 },
    ];
    const trend = composeAiCostTrend({
      asOfMonth: "2026-08",
      windowMonths: 1,
      monthTotals: new Map([["2026-08", { totalPence: 1000, invocations: 4 }]]),
      byFeature,
    });
    expect(trend.byFeature).toEqual(byFeature);
  });
});
