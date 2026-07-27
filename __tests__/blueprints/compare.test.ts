import { describe, it, expect } from "vitest";
import {
  defaultRevisionPair, isValidPair, clampPageNum, seedPagePair, pageCountsDiffer,
  aspectDrift, overlayAllowed, clampOpacity, parseCompareState, serializeAnn,
  compareSearch, compareSummary, COMPARE_MODES,
  type CompareVersion,
} from "@/lib/blueprints/compare";

const V = (id: string, version: number, revision: string): CompareVersion => ({
  id, version, revision, revision_date: "2026-01-01", uploaded_at: "2026-01-02", mime_type: "application/pdf",
});
// version-DESC chain, as the register loads it
const chain = [V("c", 3, "Rev C"), V("b", 2, "Rev B"), V("a", 1, "Rev A")];

describe("revision selection", () => {
  it("defaults to current (B) vs immediately-previous (A)", () => {
    expect(defaultRevisionPair(chain)).toEqual({ a: "b", b: "c" });
  });
  it("returns null with fewer than two versions", () => {
    expect(defaultRevisionPair([V("only", 1, "Rev A")])).toBeNull();
    expect(defaultRevisionPair([])).toBeNull();
  });
  it("rejects A==B and unknown ids", () => {
    expect(isValidPair(chain, "b", "c")).toBe(true);
    expect(isValidPair(chain, "c", "c")).toBe(false);
    expect(isValidPair(chain, "c", "zzz")).toBe(false);
  });
});

describe("page pairing", () => {
  it("clamps a page number into [1, count]", () => {
    expect(clampPageNum(0, 4)).toBe(1);
    expect(clampPageNum(9, 4)).toBe(4);
    expect(clampPageNum(3, 4)).toBe(3);
    expect(clampPageNum(NaN, 4)).toBe(1);
  });
  it("seeds a pair within each side's count", () => {
    expect(seedPagePair(2, 5, 4, 6)).toEqual({ pageA: 2, pageB: 5 });
    expect(seedPagePair(9, 9, 4, 6)).toEqual({ pageA: 4, pageB: 6 });
  });
  it("flags count mismatch", () => {
    expect(pageCountsDiffer(4, 6)).toBe(true);
    expect(pageCountsDiffer(3, 3)).toBe(false);
  });
});

describe("overlay dimension compatibility", () => {
  it("treats the whole ISO A-series (same √2 aspect) as compatible", () => {
    const a0 = { w: 2384, h: 3370 }; // A0
    const a3 = { w: 842, h: 1191 };  // A3
    expect(aspectDrift(a0, a3)).toBeLessThan(0.01);
    expect(overlayAllowed(a0, a3)).toBe(true);
  });
  it("rejects a portrait-vs-landscape re-issue", () => {
    expect(overlayAllowed({ w: 800, h: 1000 }, { w: 1000, h: 800 })).toBe(false);
  });
  it("is symmetric + guards degenerate boxes", () => {
    expect(aspectDrift({ w: 100, h: 200 }, { w: 200, h: 100 })).toBeCloseTo(aspectDrift({ w: 200, h: 100 }, { w: 100, h: 200 }), 10);
    expect(overlayAllowed({ w: 0, h: 100 }, { w: 100, h: 100 })).toBe(false);
  });
});

describe("clamps", () => {
  it("clamps opacity to [0,1], NaN → 0.5", () => {
    expect(clampOpacity(-1)).toBe(0);
    expect(clampOpacity(2)).toBe(1);
    expect(clampOpacity(0.4)).toBe(0.4);
    expect(clampOpacity(NaN)).toBe(0.5);
  });
});

describe("URL state", () => {
  it("parses defaults when params are absent", () => {
    const s = parseCompareState({}, chain)!;
    expect(s).toMatchObject({ a: "b", b: "c", mode: "side", sync: true, fg: "b" });
    expect(s.ann).toEqual({ aPins: false, bPins: false, aMarkup: false, bMarkup: false });
  });
  it("falls back to the default pair on a tampered/self pair", () => {
    expect(parseCompareState({ a: "c", b: "c" }, chain)).toMatchObject({ a: "b", b: "c" });
    expect(parseCompareState({ a: "x", b: "y" }, chain)).toMatchObject({ a: "b", b: "c" });
  });
  it("validates mode + clamps opacity + parses annotation toggles", () => {
    const s = parseCompareState({ mode: "overlay", op: "0.7", ann: "ap,bm", sync: "0" }, chain)!;
    expect(s.mode).toBe("overlay");
    expect(s.opacity).toBe(0.7);
    expect(s.sync).toBe(false);
    expect(s.ann).toEqual({ aPins: true, bPins: false, aMarkup: false, bMarkup: true });
    expect(parseCompareState({ mode: "evil" }, chain)!.mode).toBe("side"); // bad mode → default
  });
  it("round-trips ann + builds a UUID-only deep link (no signed urls)", () => {
    expect(serializeAnn({ aPins: true, bPins: false, aMarkup: true, bMarkup: false })).toBe("ap,am");
    const s = parseCompareState({ mode: "overlay", ann: "ap" }, chain)!;
    const q = compareSearch("bp-1", s);
    expect(q).toContain("compare=bp-1");
    expect(q).toContain("mode=overlay");
    expect(q).not.toMatch(/http|sign|token|storage/i);
  });
});

describe("a11y summary", () => {
  it("reads the mode + both revisions", () => {
    const s = compareSummary(chain[1], chain[0], "overlay");
    expect(s).toContain("Overlay");
    expect(s).toContain("Rev B");
    expect(s).toContain("Rev C");
  });
});

it("exposes exactly three modes", () => {
  expect([...COMPARE_MODES]).toEqual(["side", "overlay", "diff"]);
});
