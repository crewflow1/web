import { describe, it, expect } from "vitest";
import {
  clamp01,
  normalizeLexical,
  hybridScore,
  hybridRank,
  chunkText,
  DEFAULT_WEIGHTS,
} from "@/lib/search/semantic/rank";
import type { SemanticHit } from "@/lib/search/semantic/types";

function hit(over: Partial<SemanticHit>): SemanticHit {
  return {
    sourceTable: "jobs",
    sourceId: over.sourceId ?? "id",
    jobId: null,
    visibility: "member",
    snippet: "",
    cosSim: null,
    tsRank: 0,
    ...over,
  };
}

describe("tenant semantic ranker — clamp + normalise", () => {
  it("clamp01 bounds to [0,1] and kills non-finite", () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(0.3)).toBeCloseTo(0.3);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Infinity)).toBe(1);
  });

  it("normalizeLexical is monotonic, zero-at-zero, asymptotes below 1", () => {
    expect(normalizeLexical(0)).toBe(0);
    expect(normalizeLexical(-3)).toBe(0);
    expect(normalizeLexical(1)).toBeCloseTo(0.5);
    expect(normalizeLexical(9)).toBeCloseTo(0.9);
    expect(normalizeLexical(1)).toBeLessThan(normalizeLexical(2));
    expect(normalizeLexical(1e9)).toBeLessThan(1);
  });
});

describe("tenant semantic ranker — hybridScore", () => {
  it("a pure semantic hit scores on cosine alone", () => {
    const s = hybridScore(hit({ cosSim: 1, tsRank: 0 }));
    expect(s).toBeCloseTo(DEFAULT_WEIGHTS.semantic);
  });

  it("a pure lexical hit (no vector) scores on ts_rank alone", () => {
    const s = hybridScore(hit({ cosSim: null, tsRank: 1e9 }));
    // normalizeLexical(1e9) ≈ 1 → ≈ lexical weight
    expect(s).toBeGreaterThan(DEFAULT_WEIGHTS.lexical - 0.01);
    expect(s).toBeLessThanOrEqual(DEFAULT_WEIGHTS.lexical);
  });

  it("blends both signals and clamps an out-of-range cosine", () => {
    const s = hybridScore(hit({ cosSim: 1.2, tsRank: 1 }));
    // cos clamped to 1, lexical 0.5 → 0.65*1 + 0.35*0.5
    expect(s).toBeCloseTo(0.65 * 1 + 0.35 * 0.5);
  });
});

describe("tenant semantic ranker — hybridRank", () => {
  it("orders by blended score descending and is pure (no mutation)", () => {
    const input = [
      hit({ sourceId: "weak", cosSim: 0.1, tsRank: 0 }),
      hit({ sourceId: "strong", cosSim: 0.95, tsRank: 0 }),
      hit({ sourceId: "mid", cosSim: 0.5, tsRank: 0 }),
    ];
    const frozen = JSON.stringify(input);
    const out = hybridRank(input);
    expect(out.map((h) => h.sourceId)).toEqual(["strong", "mid", "weak"]);
    // input not mutated
    expect(JSON.stringify(input)).toBe(frozen);
  });

  it("is stable for equal scores (input order preserved)", () => {
    const input = [
      hit({ sourceId: "a", cosSim: 0.5 }),
      hit({ sourceId: "b", cosSim: 0.5 }),
      hit({ sourceId: "c", cosSim: 0.5 }),
    ];
    expect(hybridRank(input).map((h) => h.sourceId)).toEqual(["a", "b", "c"]);
  });

  it("a semantic-only hit can outrank a lexical-only hit (the whole point)", () => {
    const lexicalOnly = hit({ sourceId: "lex", cosSim: null, tsRank: 0.2 });
    const semanticOnly = hit({ sourceId: "sem", cosSim: 0.9, tsRank: 0 });
    expect(hybridRank([lexicalOnly, semanticOnly])[0]!.sourceId).toBe("sem");
  });
});

describe("tenant semantic ranker — chunkText", () => {
  it("empty / whitespace input yields no chunks", () => {
    expect(chunkText("", 10)).toEqual([]);
    expect(chunkText("   \n  ", 10)).toEqual([]);
  });

  it("short text is a single chunk (trimmed)", () => {
    expect(chunkText("  hello world  ", 100)).toEqual(["hello world"]);
  });

  it("splits on whitespace without cutting a word", () => {
    const chunks = chunkText("alpha beta gamma delta", 12);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(12);
    expect(chunks.join(" ")).toBe("alpha beta gamma delta");
    // no chunk starts/ends mid-word (every token is whole)
    for (const c of chunks) expect(c).toMatch(/^\S.*\S$|^\S$/);
  });

  it("hard-splits an unbroken string longer than the limit (always terminates)", () => {
    const chunks = chunkText("abcdefghijklmnop", 5);
    expect(chunks.every((c) => c.length <= 5)).toBe(true);
    expect(chunks.join("")).toBe("abcdefghijklmnop");
  });
});
