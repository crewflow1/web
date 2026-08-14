import { describe, it, expect } from "vitest";
import {
  composeDecisionDebate,
  isInsufficientDebate,
  INSUFFICIENT_DEBATE_ENTRY,
  type DecisionDebateSignals,
} from "@/lib/hq/decision-debate";

/**
 * Unit proof for the DETERMINISTIC Decision-Centre debate producer (lib/hq/decision-debate.ts).
 *
 * The producer fills the reserved `ai_debate` slot from a decision's REAL signals — revenue,
 * demand, cost, risk, timeline — labelling each for/against/consideration and carrying its
 * verbatim text. It fabricates nothing (an empty decision gets an explicit "insufficient" entry),
 * it is pure (same signals → same debate), and it makes no model call — the generative tier is dark.
 */

const full: DecisionDebateSignals = {
  problem: "Customers churn at renewal.",
  businessImpact: "Retention lifts LTV across the base.",
  revenueImpact: "+£4k MRR within two quarters.",
  demand: "Top-3 requested feature this quarter.",
  engineeringCost: "Roughly 3 engineer-weeks.",
  risk: "Touches the billing path.",
  timeline: "Ship by end of Q3.",
};

describe("composeDecisionDebate — structured pro/con from real signals", () => {
  it("emits pros, then cons, then considerations, each with its verbatim signal text", () => {
    const debate = composeDecisionDebate(full);
    expect(debate.map((e) => [e.position, e.signal])).toEqual([
      ["pro", "revenue_impact"],
      ["pro", "demand"],
      ["pro", "business_impact"],
      ["con", "engineering_cost"],
      ["con", "risk"],
      ["consideration", "problem"],
      ["consideration", "timeline"],
    ]);
    // details are the operator's OWN text, verbatim — nothing paraphrased or invented.
    const revenue = debate.find((e) => e.signal === "revenue_impact")!;
    expect(revenue.detail).toBe("+£4k MRR within two quarters.");
    expect(revenue.headline).toBe("Revenue impact");
    // every entry is the deterministic tier.
    expect(debate.every((e) => e.source === "deterministic")).toBe(true);
  });

  it("only emits entries for PRESENT signals (a cost-only decision has exactly one con)", () => {
    const debate = composeDecisionDebate({ engineeringCost: "2 weeks" });
    expect(debate).toEqual([
      {
        position: "con",
        signal: "engineering_cost",
        headline: "Engineering cost",
        detail: "2 weeks",
        source: "deterministic",
      },
    ]);
  });

  it("treats whitespace-only / null signals as absent", () => {
    const debate = composeDecisionDebate({ revenueImpact: "   ", demand: null, risk: "real" });
    expect(debate.map((e) => e.signal)).toEqual(["risk"]);
  });

  it("is PURE and TOTAL — the same signals yield an identical debate every call", () => {
    expect(composeDecisionDebate(full)).toEqual(composeDecisionDebate(full));
  });
});

describe("composeDecisionDebate — honesty doctrine (insufficient, never fabricated)", () => {
  it("a decision with NO structured signals gets exactly one explicit insufficient entry", () => {
    const debate = composeDecisionDebate({});
    expect(debate).toEqual([INSUFFICIENT_DEBATE_ENTRY]);
    expect(isInsufficientDebate(debate)).toBe(true);
  });

  it("a real debate is NOT flagged insufficient", () => {
    expect(isInsufficientDebate(composeDecisionDebate(full))).toBe(false);
  });
});
