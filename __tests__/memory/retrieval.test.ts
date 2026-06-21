import { describe, it, expect } from "vitest";
import { canEmployeeAccess } from "@/lib/memory/model";
import {
  estimateTokens,
  exponentialDecay,
  cosineSimilarity,
  clamp,
  scoreCandidate,
  effectiveScore,
  evictionOrder,
  diversify,
  assembleContext,
  DEFAULT_WEIGHTS_BY_CLASS,
} from "@/lib/memory/retrieval";

/**
 * Shared Memory — pure retrieval-engine contract tests
 * (CrewFlow Bible Volume X §7–§10; CEO Directive 009 Module 1, gate 3).
 *
 * Proves the four pure cores of the recall pipeline behave to spec WITHOUT
 * a database: the scoring function, the decay model, the diversify/dedupe
 * step, and the token-budget knapsack — plus the owner-aware permission
 * predicate that the SQL stage-1 filter mirrors.
 */

// ---------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------

describe("primitive helpers", () => {
  it("estimateTokens is ~chars/4 and never zero for non-empty text", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("x".repeat(40))).toBe(10);
  });

  it("exponentialDecay is 1 at age 0 and monotonically decreasing", () => {
    expect(exponentialDecay(0, 1000)).toBe(1);
    expect(exponentialDecay(1000, 1000)).toBeCloseTo(Math.exp(-1), 6);
    expect(exponentialDecay(5000, 1000)).toBeLessThan(exponentialDecay(1000, 1000));
    expect(exponentialDecay(1000, 0)).toBe(0); // degenerate τ
  });

  it("cosineSimilarity: identical=1, orthogonal=0, degenerate=0", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0); // length mismatch
  });

  it("clamp bounds to [lo, hi]", () => {
    expect(clamp(-1)).toBe(0);
    expect(clamp(2)).toBe(1);
    expect(clamp(0.5)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------
// §7.3 scoring
// ---------------------------------------------------------------------

describe("scoreCandidate (Volume X §7.3)", () => {
  it("default per-class weights each sum to ~1", () => {
    for (const w of Object.values(DEFAULT_WEIGHTS_BY_CLASS)) {
      const sum =
        w.semantic + w.lexical + w.recency + w.salience + w.importance + w.popularity + w.pinned + w.structural;
      expect(sum).toBeCloseTo(1, 6);
    }
  });

  it("is monotonic in semantic similarity", () => {
    const lo = scoreCandidate({ memoryClass: "semantic", cosSim: 0.1 });
    const hi = scoreCandidate({ memoryClass: "semantic", cosSim: 0.9 });
    expect(hi).toBeGreaterThan(lo);
  });

  it("weights recency for episodic far above semantic", () => {
    // Fresh memory (age 0 → recency 1), no other query signal.
    const episodic = scoreCandidate({ memoryClass: "episodic", ageMs: 0 });
    const semantic = scoreCandidate({ memoryClass: "semantic", ageMs: 0 });
    expect(episodic).toBeGreaterThan(semantic);
  });

  it("pinned memory is floor-boosted above any unpinned baseline", () => {
    const pinned = scoreCandidate({ memoryClass: "semantic", pinned: true });
    const unpinned = scoreCandidate({ memoryClass: "semantic" });
    expect(pinned).toBeGreaterThanOrEqual(0.8);
    expect(unpinned).toBeLessThan(0.8);
    expect(pinned).toBeGreaterThan(unpinned);
  });

  it("keeps a well-matched candidate within [0,1] for default weights", () => {
    const s = scoreCandidate({
      memoryClass: "semantic",
      cosSim: 1,
      tsRank: 1,
      salience: 100,
      importanceRank: 3,
      accessCount: 1000,
      structuralMatch: 1,
    });
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------
// §10 decay + eviction
// ---------------------------------------------------------------------

describe("effectiveScore + evictionOrder (Volume X §10)", () => {
  const DAY = 86_400_000;

  it("decays with age and scales with salience", () => {
    const fresh = effectiveScore({ ageMs: 0, tauMs: DAY, salience: 100 });
    const old = effectiveScore({ ageMs: 3 * DAY, tauMs: DAY, salience: 100 });
    const faint = effectiveScore({ ageMs: 0, tauMs: DAY, salience: 20 });
    expect(fresh).toBeCloseTo(1, 6);
    expect(old).toBeLessThan(fresh);
    expect(faint).toBeLessThan(fresh);
  });

  it("reinforcement keeps used memory alive longer", () => {
    const used = effectiveScore({ ageMs: DAY, tauMs: DAY, salience: 80, reinforcement: 1.5 });
    const unused = effectiveScore({ ageMs: DAY, tauMs: DAY, salience: 80, reinforcement: 1 });
    expect(used).toBeGreaterThan(unused);
  });

  it("evicts lowest-value ephemeral first and never touches durable knowledge", () => {
    const order = evictionOrder([
      { id: "semantic-brain", memoryClass: "semantic", ageMs: 9999 * DAY, tauMs: DAY, salience: 1 },
      { id: "stale-working", memoryClass: "working", ageMs: 5 * DAY, tauMs: DAY, salience: 10 },
      { id: "fresh-episode", memoryClass: "episodic", ageMs: 0, tauMs: 30 * DAY, salience: 90 },
    ]);
    // Durable semantic is never an eviction candidate.
    expect(order).not.toContain("semantic-brain");
    // The stale, low-salience working memory is evicted before the fresh episode.
    expect(order[0]).toBe("stale-working");
    expect(order).toEqual(["stale-working", "fresh-episode"]);
  });
});

// ---------------------------------------------------------------------
// §7.4 diversify + dedupe
// ---------------------------------------------------------------------

describe("diversify (Volume X §7.4)", () => {
  it("drops a memory superseded by an already-selected newer version", () => {
    const out = diversify([
      { id: "v2", score: 0.9, supersededBy: null },
      { id: "v1", score: 0.8, supersededBy: "v2" },
    ]);
    expect(out.map((i) => i.id)).toEqual(["v2"]);
  });

  it("drops near-duplicates by cosine, keeping the higher score", () => {
    const out = diversify([
      { id: "keep", score: 0.9, embedding: [1, 0, 0] },
      { id: "dup", score: 0.5, embedding: [1, 0, 0.01] },
      { id: "distinct", score: 0.4, embedding: [0, 1, 0] },
    ]);
    expect(out.map((i) => i.id)).toContain("keep");
    expect(out.map((i) => i.id)).toContain("distinct");
    expect(out.map((i) => i.id)).not.toContain("dup");
  });

  it("enforces a per-type soft cap to spread the context", () => {
    const items = Array.from({ length: 6 }, (_, n) => ({
      id: `m${n}`,
      score: 1 - n * 0.1,
      memoryType: "objection",
    }));
    const out = diversify(items, { maxPerType: 4 });
    expect(out).toHaveLength(4);
    // Highest-scoring four survive.
    expect(out.map((i) => i.id)).toEqual(["m0", "m1", "m2", "m3"]);
  });

  it("respects an absolute limit", () => {
    const out = diversify(
      [
        { id: "a", score: 0.9 },
        { id: "b", score: 0.8 },
        { id: "c", score: 0.7 },
      ],
      { limit: 2 },
    );
    expect(out).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------
// §8 budget knapsack
// ---------------------------------------------------------------------

describe("assembleContext (Volume X §8)", () => {
  it("packs by score, summarises overflow, drops what cannot fit", () => {
    const res = assembleContext(
      [
        { id: "pinned", tokens: 20, score: 0, alwaysIn: true },
        { id: "a", tokens: 50, score: 0.9 },
        { id: "b", tokens: 60, summaryTokens: 30, score: 0.8 },
        { id: "c", tokens: 40, score: 0.1 },
      ],
      100,
    );
    expect(res.included).toContain("pinned");
    expect(res.included).toContain("a");
    expect(res.summarised).toContain("b");
    expect(res.dropped).toContain("c");
    expect(res.tokensUsed).toBeLessThanOrEqual(res.budget);
  });

  it("never drops an always-in item, even when it busts the budget", () => {
    const res = assembleContext(
      [{ id: "must", tokens: 50, score: 0, alwaysIn: true }],
      10,
    );
    expect(res.included).toContain("must");
    expect(res.dropped).not.toContain("must");
    expect(res.tokensUsed).toBeGreaterThan(res.budget);
  });

  it("prefers a summary when the full body would overflow", () => {
    const res = assembleContext(
      [{ id: "big", tokens: 200, summaryTokens: 20, score: 1 }],
      100,
    );
    expect(res.summarised).toEqual(["big"]);
    expect(res.included).toEqual([]);
  });
});

// ---------------------------------------------------------------------
// Owner-aware permission predicate (Volume X §6) — additive to D002 model
// ---------------------------------------------------------------------

describe("canEmployeeAccess with owner_employee_id (Volume X §6)", () => {
  const alice = { id: "emp-alice", department: "sales" };
  const noGrants: never[] = [];

  it("public_hq is readable by anyone", () => {
    expect(canEmployeeAccess({ visibility: "public_hq", department: null }, alice, noGrants)).toBe(true);
  });

  it("system is never surfaced — not even to the owner", () => {
    expect(
      canEmployeeAccess(
        { visibility: "system", department: "sales", owner_employee_id: "emp-alice" },
        alice,
        noGrants,
      ),
    ).toBe(false);
  });

  it("an employee can read its OWN private experience", () => {
    expect(
      canEmployeeAccess(
        { visibility: "private", department: null, owner_employee_id: "emp-alice" },
        alice,
        noGrants,
      ),
    ).toBe(true);
  });

  it("an employee cannot read ANOTHER employee's private memory", () => {
    expect(
      canEmployeeAccess(
        { visibility: "private", department: "sales", owner_employee_id: "emp-bob" },
        alice,
        noGrants,
      ),
    ).toBe(false);
  });

  it("department visibility honours the department, an explicit grant, or ownership", () => {
    expect(canEmployeeAccess({ visibility: "department", department: "sales" }, alice, noGrants)).toBe(true);
    expect(canEmployeeAccess({ visibility: "department", department: "finance" }, alice, noGrants)).toBe(false);
    expect(
      canEmployeeAccess(
        { visibility: "department", department: "finance", owner_employee_id: "emp-alice" },
        alice,
        noGrants,
      ),
    ).toBe(true);
    expect(
      canEmployeeAccess({ visibility: "department", department: "finance" }, alice, [
        { grantee_type: "department", grantee_value: "sales" },
      ]),
    ).toBe(true);
  });

  it("restricted requires a matching grant", () => {
    expect(
      canEmployeeAccess({ visibility: "restricted", department: null }, alice, [
        { grantee_type: "employee", grantee_value: "emp-alice" },
      ]),
    ).toBe(true);
    expect(canEmployeeAccess({ visibility: "restricted", department: null }, alice, noGrants)).toBe(false);
  });

  it("fails closed on an unknown visibility", () => {
    expect(canEmployeeAccess({ visibility: "nonsense", department: null }, alice, noGrants)).toBe(false);
  });
});
