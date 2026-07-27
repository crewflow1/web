import { describe, it, expect } from "vitest";
import { rankAndAssemble, type RecallCandidate } from "@/lib/memory/retrieval";

/**
 * Shared Memory — pure recall-orchestrator contract tests
 * (CrewFlow Bible Volume X §7.3 → §7.4 → §8; CEO Directive 009 Module 1, PR3).
 *
 * `rankAndAssemble` composes the three already-proven pure cores (scoring,
 * diversify, knapsack) into the ranked, budget-bounded manifest the SDK packs
 * into a prompt. These tests pin the COMPOSITION — that scoring orders the
 * set, diversify drops superseded/duplicate candidates, the budget summarises
 * then drops overflow, pinned candidates are non-negotiable, and the result is
 * deterministic — WITHOUT a database. Permission is deliberately absent here:
 * it is enforced upstream in SQL (hq_memory_recall stage 1), so this layer
 * cannot widen it and never sees a non-permitted candidate.
 */

/** A fully-specified durable candidate with a generous body. */
function cand(over: Partial<RecallCandidate> & { id: string }): RecallCandidate {
  return {
    memoryClass: "semantic",
    bodyTokens: 100,
    summaryTokens: 20,
    ...over,
  };
}

describe("rankAndAssemble — composition (Volume X §7)", () => {
  it("returns an empty manifest for no candidates", () => {
    const out = rankAndAssemble([], { tokenBudget: 1000 });
    expect(out.items).toEqual([]);
    expect(out.scored).toEqual([]);
    expect(out.manifest.included).toEqual([]);
    expect(out.manifest.tokensUsed).toBe(0);
    expect(out.manifest.budget).toBe(1000);
  });

  it("orders assembled items by blended score, highest first", () => {
    const out = rankAndAssemble(
      [
        cand({ id: "weak", tsRank: 0.1 }),
        cand({ id: "strong", tsRank: 0.9 }),
        cand({ id: "mid", tsRank: 0.5 }),
      ],
      { tokenBudget: 100000 },
    );
    expect(out.items.map((i) => i.id)).toEqual(["strong", "mid", "weak"]);
    // Every candidate is scored for observability, not just the assembled ones.
    expect(out.scored.map((s) => s.id).sort()).toEqual(["mid", "strong", "weak"]);
  });

  it("scores every candidate even when the budget drops some", () => {
    const out = rankAndAssemble(
      [
        cand({ id: "a", tsRank: 0.9, bodyTokens: 80, summaryTokens: 80 }),
        cand({ id: "b", tsRank: 0.1, bodyTokens: 80, summaryTokens: 80 }),
      ],
      { tokenBudget: 80 },
    );
    // Only one fits; the other is dropped — but BOTH were scored.
    expect(out.scored).toHaveLength(2);
    expect(out.manifest.included).toEqual(["a"]);
    expect(out.manifest.dropped).toContain("b");
    expect(out.items.map((i) => i.id)).toEqual(["a"]);
  });

  it("summarises an overflowing body, then marks its form 'summary'", () => {
    const out = rankAndAssemble(
      [cand({ id: "big", tsRank: 1, bodyTokens: 5000, summaryTokens: 40 })],
      { tokenBudget: 100 },
    );
    expect(out.manifest.summarised).toEqual(["big"]);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.form).toBe("summary");
  });

  it("drops an episode superseded by an already-selected consolidation", () => {
    const out = rankAndAssemble(
      [
        cand({ id: "rollup", memoryClass: "long_term", tsRank: 0.9 }),
        cand({ id: "episode", memoryClass: "episodic", tsRank: 0.8, supersededBy: "rollup" }),
      ],
      { tokenBudget: 100000 },
    );
    expect(out.items.map((i) => i.id)).toEqual(["rollup"]);
    expect(out.items.map((i) => i.id)).not.toContain("episode");
  });

  it("treats a pinned candidate as always-in — assembled even when the budget is busted", () => {
    const out = rankAndAssemble(
      [
        cand({ id: "pinned", pinned: true, bodyTokens: 50, summaryTokens: 50 }),
        cand({ id: "filler", tsRank: 0.9, bodyTokens: 50, summaryTokens: 50 }),
      ],
      { tokenBudget: 10 },
    );
    // The pinned memory is non-negotiable; it is present despite the tiny budget.
    const ids = out.items.map((i) => i.id);
    expect(ids).toContain("pinned");
    expect(out.manifest.dropped).not.toContain("pinned");
  });

  it("is deterministic — identical input yields identical output", () => {
    const input = [
      cand({ id: "a", tsRank: 0.7, memoryType: "objection" }),
      cand({ id: "b", tsRank: 0.6, memoryType: "objection" }),
      cand({ id: "c", tsRank: 0.5, memoryType: "playbook" }),
    ];
    const a = rankAndAssemble(input, { tokenBudget: 1000 });
    const b = rankAndAssemble(input, { tokenBudget: 1000 });
    expect(a).toEqual(b);
  });

  it("honours the diversify per-type soft cap passed through", () => {
    const items = Array.from({ length: 6 }, (_, n) =>
      cand({ id: `m${n}`, tsRank: 1 - n * 0.1, memoryType: "objection", bodyTokens: 1, summaryTokens: 1 }),
    );
    const out = rankAndAssemble(items, { tokenBudget: 100000, diversify: { maxPerType: 2 } });
    // Only the two highest-scoring of the same type survive the spread cap.
    expect(out.items).toHaveLength(2);
    expect(out.items.map((i) => i.id)).toEqual(["m0", "m1"]);
  });
});
