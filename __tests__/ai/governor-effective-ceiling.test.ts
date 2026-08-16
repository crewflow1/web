import { describe, it, expect } from "vitest";
import {
  AI_MONTHLY_CEILING_PENCE,
  AI_MONTHLY_CEILING_HARD_MAX_PENCE,
  effectiveCeilingPence,
  isAcceptableLimitPence,
  evaluateBudget,
} from "@/lib/ai/governor/policy";

/**
 * The EFFECTIVE-CEILING resolution rule, at the boundaries it must hold at.
 *
 * `effectiveCeilingPence` is the single pure definition of `override ?? default`,
 * clamped to `[0, hardMax]`. The SQL reserve function mirrors it under its lock;
 * ai-budget-controls.test.ts pins that the two agree on the numbers that matter.
 */
describe("effectiveCeilingPence — override ?? default, clamped", () => {
  it("returns the DEFAULT when there is no override", () => {
    expect(effectiveCeilingPence(null)).toBe(AI_MONTHLY_CEILING_PENCE);
    expect(effectiveCeilingPence(undefined)).toBe(AI_MONTHLY_CEILING_PENCE);
  });

  it("returns the OVERRIDE when one is set and within bounds", () => {
    expect(effectiveCeilingPence(3_000)).toBe(3_000); // £30, below default
    expect(effectiveCeilingPence(20_000)).toBe(20_000); // £200, above default
  });

  it("honours a ZERO override as 'no AI at all', never the default", () => {
    expect(effectiveCeilingPence(0)).toBe(0);
    // And a zero ceiling blocks — the failure-safe reading, unchanged.
    expect(evaluateBudget(0, effectiveCeilingPence(0))).toBe("blocked");
  });

  it("CLAMPS an override to the hard safety max — it can never widen the gate", () => {
    expect(effectiveCeilingPence(AI_MONTHLY_CEILING_HARD_MAX_PENCE + 1)).toBe(
      AI_MONTHLY_CEILING_HARD_MAX_PENCE,
    );
    expect(effectiveCeilingPence(999_999_999)).toBe(AI_MONTHLY_CEILING_HARD_MAX_PENCE);
  });

  it("falls back to the DEFAULT on a garbage override (never silently raises)", () => {
    expect(effectiveCeilingPence(Number.NaN)).toBe(AI_MONTHLY_CEILING_PENCE);
    expect(effectiveCeilingPence(Number.POSITIVE_INFINITY)).toBe(AI_MONTHLY_CEILING_PENCE);
    expect(effectiveCeilingPence(-5)).toBe(AI_MONTHLY_CEILING_PENCE);
  });

  it("rounds a fractional override to whole pence", () => {
    expect(effectiveCeilingPence(1234.6)).toBe(1235);
  });

  it("the hard max is strictly greater than the default (an override CAN raise)", () => {
    expect(AI_MONTHLY_CEILING_HARD_MAX_PENCE).toBeGreaterThan(AI_MONTHLY_CEILING_PENCE);
  });
});

describe("isAcceptableLimitPence — the editor's own gate", () => {
  it("accepts 0..hardMax integers", () => {
    expect(isAcceptableLimitPence(0)).toBe(true);
    expect(isAcceptableLimitPence(AI_MONTHLY_CEILING_PENCE)).toBe(true);
    expect(isAcceptableLimitPence(AI_MONTHLY_CEILING_HARD_MAX_PENCE)).toBe(true);
  });

  it("rejects above the hard max, negative, fractional and non-finite", () => {
    expect(isAcceptableLimitPence(AI_MONTHLY_CEILING_HARD_MAX_PENCE + 1)).toBe(false);
    expect(isAcceptableLimitPence(-1)).toBe(false);
    expect(isAcceptableLimitPence(10.5)).toBe(false);
    expect(isAcceptableLimitPence(Number.NaN)).toBe(false);
  });
});
