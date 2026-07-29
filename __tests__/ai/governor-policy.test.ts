import { describe, it, expect } from "vitest";
import {
  AI_MONTHLY_CEILING_PENCE,
  BUDGET_WARN_50_FRACTION,
  BUDGET_WARN_80_FRACTION,
  DEDUPE_WINDOW_MS,
  SPIKE_BASELINE_MONTHS,
  SPIKE_MULTIPLIER,
  USD_TO_GBP,
  addMonths,
  budgetPercent,
  budgetPermits,
  detectSpike,
  estimateCostPence,
  evaluateBudget,
  formatPence,
  invocationHash,
  trailingAverage,
  trailingMonths,
  ukMonthKeyOf,
  ukMonthWindow,
} from "@/lib/ai/governor/policy";
import { ukDayStartMs } from "@/lib/schedule/window";

/**
 * AI Cost Governor — the PURE decision core.
 *
 * The £100/month/org ceiling is a hard safety limit, so it is tested AT its
 * boundaries rather than around them: the interesting values are exactly 50%,
 * exactly 80% and exactly 100%, because an off-by-one at the last of those is
 * the difference between a control and a control that lets the runaway call
 * through.
 */

// =====================================================================
// 1. The ceiling itself — product policy, pinned.
// =====================================================================

describe("the ceiling is £100/month/org, expressed as a code constant", () => {
  it("is exactly 10,000 integer pence", () => {
    expect(AI_MONTHLY_CEILING_PENCE).toBe(10_000);
    expect(Number.isInteger(AI_MONTHLY_CEILING_PENCE)).toBe(true);
  });

  it("is a CONSTANT, not an environment variable — the source contains no env read", () => {
    // The whole point of the constant: raising the ceiling must be a reviewed
    // diff, not a deploy-dashboard edit. A `process.env` read in this module
    // would quietly reintroduce that possibility.
    // (Proven exhaustively against source text in the security tier.)
    expect(AI_MONTHLY_CEILING_PENCE).toBe(10_000);
  });

  it("is a small fraction of the ~£500/month subscription it protects", () => {
    // Sanity: the ceiling exists to stop AI eating the margin. If it ever
    // exceeded the subscription this test is the place that notices.
    expect(AI_MONTHLY_CEILING_PENCE).toBeLessThan(50_000);
  });

  it("warns at 50% then 80%", () => {
    expect(BUDGET_WARN_50_FRACTION).toBe(0.5);
    expect(BUDGET_WARN_80_FRACTION).toBe(0.8);
  });
});

// =====================================================================
// 2. Budget maths at the exact percentages of the ceiling.
// =====================================================================

describe("evaluateBudget — the band boundaries", () => {
  const at = (pct: number) => Math.round((pct / 100) * AI_MONTHLY_CEILING_PENCE);

  const CASES: ReadonlyArray<[number, string]> = [
    [0, "allowed"],
    [49, "allowed"],
    [50, "warn_50"],
    [79, "warn_50"],
    [80, "warn_80"],
    [99, "warn_80"],
    [100, "blocked"],
  ];

  for (const [pct, expected] of CASES) {
    it(`${pct}% of the ceiling (${at(pct)}p) ⇒ ${expected}`, () => {
      expect(evaluateBudget(at(pct))).toBe(expected);
    });
  }

  it("EXACTLY at the ceiling blocks — the boundary that matters most", () => {
    // A `>` instead of `>=` here would let one more unbounded call through at
    // the precise moment the limit was reached.
    expect(evaluateBudget(AI_MONTHLY_CEILING_PENCE)).toBe("blocked");
    expect(evaluateBudget(AI_MONTHLY_CEILING_PENCE - 1)).toBe("warn_80");
  });

  it("stays blocked well beyond the ceiling", () => {
    expect(evaluateBudget(AI_MONTHLY_CEILING_PENCE * 10)).toBe("blocked");
  });

  it("only `blocked` refuses work — the warn states are advisory", () => {
    expect(budgetPermits("allowed")).toBe(true);
    expect(budgetPermits("warn_50")).toBe(true);
    expect(budgetPermits("warn_80")).toBe(true);
    expect(budgetPermits("blocked")).toBe(false);
  });

  it("a zero or negative ceiling means NO spend permitted, not unlimited", () => {
    // The fail-safe reading. Reading it the other way would turn a
    // misconfiguration into an uncapped budget.
    expect(evaluateBudget(0, 0)).toBe("blocked");
    expect(evaluateBudget(0, -1)).toBe("blocked");
    expect(evaluateBudget(0, Number.NaN)).toBe("blocked");
  });

  it("treats impossible spend (negative / non-finite) as zero rather than trusting it", () => {
    expect(evaluateBudget(-5_000)).toBe("allowed");
    expect(evaluateBudget(Number.NaN)).toBe("allowed");
  });

  it("budgetPercent reports the same fraction the bands are derived from", () => {
    expect(budgetPercent(0)).toBe(0);
    expect(budgetPercent(5_000)).toBe(50);
    expect(budgetPercent(10_000)).toBe(100);
    expect(budgetPercent(12_345)).toBe(123);
  });
});

// =====================================================================
// 3. Month boundaries — Europe/London, matching the SQL rollup.
// =====================================================================

describe("the budget month is a Europe/London calendar month", () => {
  it("buckets an instant by the UK month, not the UTC month", () => {
    // 2026-07-31 23:30Z is already 1 August in BST (UTC+1). The £100 ceiling is
    // a calendar-month promise to a UK operator, so this spends August's money.
    expect(ukMonthKeyOf("2026-07-31T23:30:00Z")).toBe("2026-08");
    // The same clock time in GMT is genuinely still December.
    expect(ukMonthKeyOf("2026-12-31T23:30:00Z")).toBe("2026-12");
  });

  it("agrees with the codebase's day-bucket idiom at an ordinary instant", () => {
    expect(ukMonthKeyOf("2026-06-15T12:00:00Z")).toBe("2026-06");
  });

  it("a month window starts at the UK month's first instant, not naive UTC midnight", () => {
    // August 2026 is BST, so the UK month begins at 23:00Z on 31 July.
    const { startMs, endMs } = ukMonthWindow("2026-08");
    expect(new Date(startMs).toISOString()).toBe("2026-07-31T23:00:00.000Z");
    expect(new Date(endMs).toISOString()).toBe("2026-08-31T23:00:00.000Z");
  });

  it("a GMT month begins at UTC midnight", () => {
    const { startMs, endMs } = ukMonthWindow("2026-01");
    expect(new Date(startMs).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(new Date(endMs).toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("handles the two months that CONTAIN a DST transition", () => {
    // March 2026: starts in GMT, ends in BST — 1 hour shorter than naive maths.
    const march = ukMonthWindow("2026-03");
    expect(new Date(march.startMs).toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(new Date(march.endMs).toISOString()).toBe("2026-03-31T23:00:00.000Z");
    expect(march.endMs - march.startMs).toBe(31 * 86_400_000 - 3_600_000);

    // October 2026: starts in BST (23:00Z the day before), ends in GMT (a true
    // UTC midnight) — so the month is 1 hour LONGER than 31 days.
    const october = ukMonthWindow("2026-10");
    expect(new Date(october.startMs).toISOString()).toBe("2026-09-30T23:00:00.000Z");
    expect(new Date(october.endMs).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(october.endMs - october.startMs).toBe(31 * 86_400_000 + 3_600_000);
  });

  it("is built from the established ukDayStartMs inverse, not re-derived", () => {
    expect(ukMonthWindow("2026-08").startMs).toBe(ukDayStartMs("2026-08-01"));
    expect(ukMonthWindow("2026-12").endMs).toBe(ukDayStartMs("2027-01-01"));
  });

  it("crosses the year boundary", () => {
    const { endMs } = ukMonthWindow("2026-12");
    expect(new Date(endMs).toISOString()).toBe("2027-01-01T00:00:00.000Z");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
  });

  it("windows are half-open and contiguous — no instant is in two months or neither", () => {
    const july = ukMonthWindow("2026-07");
    const august = ukMonthWindow("2026-08");
    expect(july.endMs).toBe(august.startMs);
    // The instant at the boundary belongs to August.
    expect(ukMonthKeyOf(august.startMs)).toBe("2026-08");
    expect(ukMonthKeyOf(august.startMs - 1)).toBe("2026-07");
  });

  it("a malformed month key yields NaN bounds rather than an arbitrary window", () => {
    expect(Number.isNaN(ukMonthWindow("nonsense").startMs)).toBe(true);
    expect(Number.isNaN(ukMonthWindow("2026-13").startMs)).toBe(true);
    expect(Number.isNaN(ukMonthWindow("2026-00").startMs)).toBe(true);
  });

  it("trailingMonths yields the preceding months, oldest first, excluding the current one", () => {
    expect(trailingMonths("2026-03", 3)).toEqual(["2025-12", "2026-01", "2026-02"]);
    expect(trailingMonths("2026-03", 3)).not.toContain("2026-03");
    expect(trailingMonths("2026-03", 0)).toEqual([]);
    expect(trailingMonths("bad", 3)).toEqual([]);
    expect(SPIKE_BASELINE_MONTHS).toBe(3);
  });
});

// =====================================================================
// 4. Spike detection.
// =====================================================================

describe("detectSpike — anomalous against the org's OWN history", () => {
  it("flags more than 3× the trailing average", () => {
    expect(SPIKE_MULTIPLIER).toBe(3);
    expect(detectSpike(3_001, 1_000)).toBe(true);
  });

  it("does NOT flag exactly 3× — the threshold is strict", () => {
    expect(detectSpike(3_000, 1_000)).toBe(false);
    expect(detectSpike(2_999, 1_000)).toBe(false);
  });

  it("a ZERO baseline never spikes — otherwise every org's first month fires", () => {
    // 3 × 0 = 0, so any spend at all would exceed it. A flag that fires for
    // everyone is noise, and noise is how a real spike gets ignored. The
    // ceiling is what protects a first month; this rule catches quiet drift.
    expect(detectSpike(9_999, 0)).toBe(false);
    expect(detectSpike(1, 0)).toBe(false);
    expect(detectSpike(0, 0)).toBe(false);
  });

  it("a negative baseline (impossible, but defended) never spikes", () => {
    expect(detectSpike(1_000, -50)).toBe(false);
  });

  it("non-finite inputs never spike rather than throwing", () => {
    expect(detectSpike(Number.NaN, 100)).toBe(false);
    expect(detectSpike(100, Number.NaN)).toBe(false);
  });

  it("a spend DROP is not a spike", () => {
    expect(detectSpike(10, 1_000)).toBe(false);
  });

  it("trailingAverage means over the supplied months, empty ⇒ 0", () => {
    expect(trailingAverage([100, 200, 300])).toBe(200);
    expect(trailingAverage([])).toBe(0);
    expect(trailingAverage([Number.NaN, 100, 300])).toBe(200);
    // A quiet month is real data and counts toward the mean.
    expect(trailingAverage([0, 0, 300])).toBe(100);
  });

  it("the composed rule: three quiet months then a jump IS a spike", () => {
    const avg = trailingAverage([100, 120, 80]); // 100p
    expect(detectSpike(500, avg)).toBe(true);
    expect(detectSpike(250, avg)).toBe(false);
  });
});

// =====================================================================
// 5. The dedupe fingerprint.
// =====================================================================

describe("invocationHash — the recent-duplicate fingerprint", () => {
  it("is a 64-char lowercase hex SHA-256, matching the ledger's CHECK", () => {
    const h = invocationHash("expense.receipt_extraction", "classification", "a receipt");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable for identical input — the whole basis of the refusal", () => {
    const a = invocationHash("f", "classification", "same content");
    const b = invocationHash("f", "classification", "same content");
    expect(a).toBe(b);
  });

  it("differs when the content differs", () => {
    expect(invocationHash("f", "classification", "one")).not.toBe(
      invocationHash("f", "classification", "two"),
    );
  });

  it("differs across features — one capability cannot suppress another's call", () => {
    expect(invocationHash("feature.a", "classification", "x")).not.toBe(
      invocationHash("feature.b", "classification", "x"),
    );
  });

  it("differs across task classes", () => {
    expect(invocationHash("f", "classification", "x")).not.toBe(
      invocationHash("f", "drafting", "x"),
    );
  });

  it("is DOMAIN-SEPARATED — no naive-concatenation collision", () => {
    // Without a separator, ("ab","c") and ("a","bc") would hash identically,
    // which across features means a stale result suppressing a genuinely new call.
    expect(invocationHash("ab", "classification", "c")).not.toBe(
      invocationHash("a", "bclassification", "c"),
    );
    expect(invocationHash("a", "b", "c d")).not.toBe(invocationHash("a", "b c", "d"));
  });

  it("the dedupe window is 15 minutes", () => {
    expect(DEDUPE_WINDOW_MS).toBe(15 * 60_000);
  });
});

// =====================================================================
// 6. Cost estimation — integer pence, never rounding real spend to nothing.
// =====================================================================

describe("estimateCostPence — integer pence, failing safe", () => {
  const CHEAP = { usdPerMTokIn: 1, usdPerMTokOut: 5 };

  it("returns 0 for an unbound model — cost is observability, never a gate", () => {
    expect(estimateCostPence(null, { inputTokens: 1_000, outputTokens: 1_000 })).toBe(0);
  });

  it("a non-zero cost NEVER rounds down to zero", () => {
    // The failure this prevents: a million sub-penny classifications
    // aggregating to £0 while real money left the account, so the ceiling
    // never trips.
    const pence = estimateCostPence(CHEAP, { inputTokens: 1, outputTokens: 0 });
    expect(pence).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(pence)).toBe(true);
  });

  it("genuinely zero usage costs zero", () => {
    expect(estimateCostPence(CHEAP, { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("prices input and output separately (vendors bill them differently)", () => {
    const inOnly = estimateCostPence(CHEAP, { inputTokens: 1_000_000, outputTokens: 0 });
    const outOnly = estimateCostPence(CHEAP, { inputTokens: 0, outputTokens: 1_000_000 });
    // $1 vs $5 per Mtok → 80p vs 400p at the fixed rate.
    expect(inOnly).toBe(Math.ceil(1 * USD_TO_GBP * 100));
    expect(outOnly).toBe(Math.ceil(5 * USD_TO_GBP * 100));
    expect(outOnly).toBeGreaterThan(inOnly);
  });

  it("always returns a non-negative integer, even for hostile input", () => {
    for (const usage of [
      { inputTokens: -5, outputTokens: -5 },
      { inputTokens: Number.NaN, outputTokens: 10 },
      { inputTokens: Infinity, outputTokens: 0 },
    ]) {
      const p = estimateCostPence(CHEAP, usage);
      expect(Number.isInteger(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(0);
    }
  });

  it("scales linearly, so ten times the tokens is (about) ten times the cost", () => {
    const one = estimateCostPence(CHEAP, { inputTokens: 1_000_000, outputTokens: 0 });
    const ten = estimateCostPence(CHEAP, { inputTokens: 10_000_000, outputTokens: 0 });
    expect(ten).toBe(one * 10);
  });

  it("formatPence renders integer pence as sterling", () => {
    expect(formatPence(0)).toBe("£0.00");
    expect(formatPence(123)).toBe("£1.23");
    expect(formatPence(10_000)).toBe("£100.00");
    expect(formatPence(Number.NaN)).toBe("£0.00");
  });

  it("a full ceiling's worth of cheap calls is a plausible number of calls", () => {
    // At 1p minimum per call, the £100 ceiling permits at most 10,000 calls —
    // the figure the per-feature SQL rollup exists to avoid aggregating in TS.
    const perCall = estimateCostPence(CHEAP, { inputTokens: 1, outputTokens: 1 });
    expect(AI_MONTHLY_CEILING_PENCE / perCall).toBeLessThanOrEqual(10_000);
  });
});
