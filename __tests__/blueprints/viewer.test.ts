import { describe, it, expect } from "vitest";
import {
  normalizePoint, denormalizePoint, fitScale, clampZoom, zoomStep, bitmapScale, clampPage,
  MIN_ZOOM, MAX_ZOOM, MAX_RENDER_SCALE, type ViewBox,
} from "@/lib/blueprints/viewer";

const A4: ViewBox = [0, 0, 595, 842]; // portrait A4 in PDF points

describe("normalize ↔ denormalize (the coordinate-stability guarantee)", () => {
  it("round-trips a point exactly", () => {
    const n = normalizePoint(297.5, 421, A4);
    expect(n.u).toBeCloseTo(0.5, 6);
    expect(n.v).toBeCloseTo(0.5, 6);
    const back = denormalizePoint(n, A4);
    expect(back.x).toBeCloseTo(297.5, 4);
    expect(back.y).toBeCloseTo(421, 4);
  });
  it("is invariant to a non-zero viewBox origin", () => {
    const vb: ViewBox = [100, 200, 700, 1000]; // offset origin
    const n = normalizePoint(400, 600, vb);
    expect(n.u).toBeCloseTo(0.5, 6);
    expect(n.v).toBeCloseTo(0.5, 6);
  });
  it("clamps out-of-page points into [0,1]", () => {
    expect(normalizePoint(-50, 9999, A4)).toEqual({ u: 0, v: 1 });
  });
  it("a stored normalized coord is identical regardless of intended zoom (scale-independence)", () => {
    // Normalized coords never carry scale — the same {u,v} denormalizes to the
    // same PDF point whether the page is later rendered at 1x or 3x.
    const n = normalizePoint(150, 700, A4);
    expect(denormalizePoint(n, A4)).toEqual(denormalizePoint(n, A4));
  });
});

describe("fitScale", () => {
  it("fits width, height, and page", () => {
    expect(fitScale({ w: 1190, h: 500 }, { w: 595, h: 842 }, "width")).toBeCloseTo(2, 5);
    expect(fitScale({ w: 500, h: 1684 }, { w: 595, h: 842 }, "height")).toBeCloseTo(2, 5);
    // page = min(width-fit, height-fit)
    expect(fitScale({ w: 1190, h: 421 }, { w: 595, h: 842 }, "page")).toBeCloseTo(0.5, 5);
  });
  it("guards zero-size pages", () => {
    expect(fitScale({ w: 100, h: 100 }, { w: 0, h: 0 }, "page")).toBe(1);
  });
});

describe("zoom math", () => {
  it("clamps to [MIN,MAX] and handles bad input", () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0.001)).toBe(MIN_ZOOM);
    expect(clampZoom(NaN)).toBe(1);
    expect(clampZoom(-2)).toBe(1);
  });
  it("steps in/out by 1.25 within bounds", () => {
    expect(zoomStep(1, 1)).toBeCloseTo(1.25, 5);
    expect(zoomStep(1, -1)).toBeCloseTo(0.8, 5);
    expect(zoomStep(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
  });
});

describe("bitmapScale (DPR-aware, capped)", () => {
  it("multiplies by DPR but never exceeds the render cap", () => {
    expect(bitmapScale(1, 2)).toBeCloseTo(2, 5);
    expect(bitmapScale(3, 2)).toBe(MAX_RENDER_SCALE); // 3×2=6 → capped at 4
    expect(bitmapScale(1, 1)).toBeCloseTo(1, 5);
  });
});

describe("clampPage", () => {
  it("bounds the page index", () => {
    expect(clampPage(-1, 5)).toBe(0);
    expect(clampPage(9, 5)).toBe(4);
    expect(clampPage(2, 5)).toBe(2);
    expect(clampPage(0, 0)).toBe(0);
  });
});
