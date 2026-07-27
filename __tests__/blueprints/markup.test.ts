import { describe, it, expect } from "vitest";
import {
  bbox, simplify, simplifyStroke,
  appendSample, isValidPointCount, hasValidPoints, isDegenerate,
  quantize, quantizePoints, normalizedToPercent, markupForSheet,
  markupGeomSchema, createMarkupSchema,
  MARKUP_KINDS, MARKUP_ARITY, MAX_FREEHAND_POINTS,
  type Norm,
} from "@/lib/blueprints/markup";

const P = (u: number, v: number): Norm => ({ u, v });

describe("bbox", () => {
  it("computes the min-corner + span", () => {
    const b = bbox([P(0.2, 0.3), P(0.6, 0.9)]);
    expect(b.u).toBeCloseTo(0.2, 10);
    expect(b.v).toBeCloseTo(0.3, 10);
    expect(b.w).toBeCloseTo(0.4, 10);
    expect(b.h).toBeCloseTo(0.6, 10);
  });
  it("handles degenerate cases without NaN", () => {
    expect(bbox([])).toEqual({ u: 0, v: 0, w: 0, h: 0 });
    expect(bbox([P(0.5, 0.5)])).toEqual({ u: 0.5, v: 0.5, w: 0, h: 0 }); // text point
    expect(bbox([P(0.1, 0.4), P(0.9, 0.4)]).h).toBe(0); // horizontal
    expect(bbox([P(0.4, 0.1), P(0.4, 0.9)]).w).toBe(0); // vertical
  });
  it("is order- and corner-independent", () => {
    const a = bbox([P(0.2, 0.8), P(0.7, 0.1)]);
    const b = bbox([P(0.7, 0.1), P(0.2, 0.8)]);
    expect(a).toEqual(b);
  });
  it("keeps the box inside the unit square (fuzz invariant)", () => {
    for (let i = 0; i < 50; i++) {
      const pts = Array.from({ length: 8 }, (_, k) => P(((i * 7 + k * 13) % 100) / 100, ((i * 3 + k * 29) % 100) / 100));
      const b = bbox(pts);
      expect(b.u).toBeGreaterThanOrEqual(0);
      expect(b.v).toBeGreaterThanOrEqual(0);
      expect(b.u + b.w).toBeLessThanOrEqual(1 + 1e-9);
      expect(b.v + b.h).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});

describe("simplify (RDP) + caps", () => {
  const line = Array.from({ length: 20 }, (_, i) => P(i / 19, 0.5)); // collinear
  it("preserves endpoints and collapses a collinear run to 2 points", () => {
    const s = simplify(line, 0.002);
    expect(s[0]).toEqual(line[0]);
    expect(s[s.length - 1]).toEqual(line[line.length - 1]);
    expect(s.length).toBe(2);
  });
  it("keeps a corner above epsilon, drops a sub-epsilon detour", () => {
    const withCorner = [P(0, 0), P(0.5, 0.5), P(1, 0)];
    expect(simplify(withCorner, 0.002).length).toBe(3);
    const tinyDetour = [P(0, 0), P(0.5, 0.0005), P(1, 0)];
    expect(simplify(tinyDetour, 0.002).length).toBe(2);
  });
  it("is idempotent and monotonic in epsilon", () => {
    const zig = Array.from({ length: 40 }, (_, i) => P(i / 39, i % 2 ? 0.5 : 0.51));
    const once = simplify(zig, 0.002);
    expect(simplify(once, 0.002)).toEqual(once);
    expect(simplify(zig, 0.05).length).toBeLessThanOrEqual(simplify(zig, 0.002).length);
  });
  it("returns <=2 pts and epsilon<=0 unchanged", () => {
    expect(simplify([P(0, 0), P(1, 1)], 0.002)).toHaveLength(2);
    const z = Array.from({ length: 10 }, (_, i) => P(i / 9, 0.3));
    expect(simplify(z, 0)).toHaveLength(10);
  });
  it("caps a 10k-point stroke at MAX_FREEHAND_POINTS without overflowing", () => {
    const huge = Array.from({ length: 10000 }, (_, i) => P(i / 9999, i % 2 ? 0.4 : 0.6));
    const s = simplifyStroke(huge);
    expect(s.length).toBeLessThanOrEqual(MAX_FREEHAND_POINTS);
    expect(s[0]).toEqual(huge[0]);
    expect(s[s.length - 1]).toEqual(huge[huge.length - 1]);
  });
  it("degenerate all-identical points → no NaN", () => {
    expect(() => simplify(Array.from({ length: 30 }, () => P(0.5, 0.5)), 0.002)).not.toThrow();
  });
});

describe("validation predicates", () => {
  it("isValidPointCount enforces per-kind arity", () => {
    expect(isValidPointCount("line", 2)).toBe(true);
    expect(isValidPointCount("line", 3)).toBe(false);
    expect(isValidPointCount("text", 1)).toBe(true);
    expect(isValidPointCount("text", 2)).toBe(false);
    expect(isValidPointCount("freehand", 2)).toBe(true);
    expect(isValidPointCount("freehand", 1)).toBe(false);
    expect(isValidPointCount("freehand", 1.5)).toBe(false);
  });
  it("hasValidPoints rejects out-of-range / NaN coords", () => {
    expect(hasValidPoints({ kind: "line", points: [P(0, 0), P(1, 1)] })).toBe(true);
    expect(hasValidPoints({ kind: "line", points: [P(0, 0), P(1.2, 1)] })).toBe(false);
    expect(hasValidPoints({ kind: "line", points: [P(0, 0), P(NaN, 1)] })).toBe(false);
  });
  it("isDegenerate flags zero-span shapes but never text", () => {
    expect(isDegenerate({ kind: "rect", points: [P(0.5, 0.5), P(0.5005, 0.5005)] })).toBe(true);
    expect(isDegenerate({ kind: "rect", points: [P(0.1, 0.1), P(0.9, 0.9)] })).toBe(false);
    expect(isDegenerate({ kind: "text", points: [P(0.5, 0.5)] })).toBe(false);
  });
  it("every MARKUP_KIND has an arity entry", () => {
    for (const k of MARKUP_KINDS) expect(MARKUP_ARITY[k]).toBeTruthy();
  });
});

describe("quantize + appendSample", () => {
  it("quantize snaps to a stable grid and clamps", () => {
    expect(quantize(0.123456789)).toBe(0.12346);
    expect(quantize(-1)).toBe(0);
    expect(quantize(2)).toBe(1);
    const q = quantizePoints([P(0.111113, 0.999997)]);
    expect(q[0]!.u).toBe(0.11111);
  });
  it("appendSample skips sub-delta jitter, keeps larger moves + order", () => {
    const a = appendSample([P(0.5, 0.5)], P(0.5001, 0.5001)); // < 0.001
    expect(a).toHaveLength(1);
    const b = appendSample([P(0.5, 0.5)], P(0.52, 0.5));
    expect(b).toHaveLength(2);
    expect(b[1]).toEqual(P(0.52, 0.5));
  });
});

describe("render mapping + sheet filter", () => {
  it("normalizedToPercent formats + clamps", () => {
    expect(normalizedToPercent(P(0.25, 0.75))).toEqual({ left: "25%", top: "75%" });
    expect(normalizedToPercent(P(-1, 2))).toEqual({ left: "0%", top: "100%" });
  });
  it("markupForSheet selects the shown sheet (0-based → 1-based)", () => {
    const rows = [{ id: "a", page_number: 1 }, { id: "b", page_number: 2 }];
    expect(markupForSheet(rows, 0).map((r) => r.id)).toEqual(["a"]);
    expect(markupForSheet(rows, 1).map((r) => r.id)).toEqual(["b"]);
  });
});

describe("schemas", () => {
  const base = { blueprint_version_id: "22222222-2222-2222-2222-222222222222", page_number: 1 };
  it("markupGeomSchema enforces arity + coord range", () => {
    expect(markupGeomSchema.safeParse({ kind: "line", points: [P(0, 0), P(1, 1)] }).success).toBe(true);
    expect(markupGeomSchema.safeParse({ kind: "line", points: [P(0, 0)] }).success).toBe(false);
    expect(markupGeomSchema.safeParse({ kind: "rect", points: [P(0, 0), P(1.5, 1)] }).success).toBe(false);
  });
  it("createMarkup requires text for a text shape + validates colour", () => {
    expect(createMarkupSchema.safeParse({ ...base, geom: { kind: "text", points: [P(0.5, 0.5)] }, text: "beam" }).success).toBe(true);
    expect(createMarkupSchema.safeParse({ ...base, geom: { kind: "text", points: [P(0.5, 0.5)] } }).success).toBe(false);
    expect(createMarkupSchema.safeParse({ ...base, geom: { kind: "line", points: [P(0, 0), P(1, 1)] }, color: "red" }).success).toBe(false);
    expect(createMarkupSchema.safeParse({ ...base, geom: { kind: "line", points: [P(0, 0), P(1, 1)] }, color: "#ff0000" }).success).toBe(true);
  });
});
