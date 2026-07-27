/**
 * Blueprint interactive viewer — PURE coordinate + zoom math (M2).
 *
 * The heart of coordinate stability lives here as pure functions so it is
 * unit-testable in a DOM-free environment (vitest runs in node; pdf.js render
 * can't). A pin/markup anchor is stored as { page, u, v } with u,v ∈ [0,1] of
 * the page's INTRINSIC (scale-1) space, so it is invariant to render scale,
 * devicePixelRatio, and screen size — proven by the round-trip tests.
 */

export type Norm = { u: number; v: number };
/** A pdf.js page viewBox: [x0, y0, x1, y1] in PDF user units. */
export type ViewBox = readonly [number, number, number, number];
export type Size = { w: number; h: number };
export type FitMode = "width" | "height" | "page";

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
/** Cap the rasterised scale so a big sheet never blows the ~16k-px canvas limit. */
export const MAX_RENDER_SCALE = 4;
/** Clamp to [0,1]; NaN → 0 (+Infinity → 1, -Infinity → 0 via min/max). Shared by the pins + markup layers. */
export const clamp01 = (n: number) => (Number.isNaN(n) ? 0 : Math.min(1, Math.max(0, n)));

/** A PDF user-space point → normalized 0..1 of the page's viewBox. */
export function normalizePoint(pdfX: number, pdfY: number, viewBox: ViewBox): Norm {
  const [x0, y0, x1, y1] = viewBox;
  const w = x1 - x0;
  const h = y1 - y0;
  return { u: w === 0 ? 0 : clamp01((pdfX - x0) / w), v: h === 0 ? 0 : clamp01((pdfY - y0) / h) };
}

/** Normalized 0..1 → PDF user-space point (inverse of normalizePoint). */
export function denormalizePoint(n: Norm, viewBox: ViewBox): { x: number; y: number } {
  const [x0, y0, x1, y1] = viewBox;
  return { x: x0 + clamp01(n.u) * (x1 - x0), y: y0 + clamp01(n.v) * (y1 - y0) };
}

/** Scale that fits a page of intrinsic size `page` into `container` for a mode. */
export function fitScale(container: Size, page: Size, mode: FitMode): number {
  if (page.w <= 0 || page.h <= 0) return 1;
  const sw = container.w / page.w;
  const sh = container.h / page.h;
  const raw = mode === "width" ? sw : mode === "height" ? sh : Math.min(sw, sh);
  return clampZoom(raw);
}

export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/** One zoom step in/out (×1.25), clamped. */
export function zoomStep(scale: number, dir: 1 | -1): number {
  return clampZoom(dir === 1 ? scale * 1.25 : scale / 1.25);
}

/**
 * The bitmap render scale = layout scale × DPR, capped. Coordinates are ALWAYS
 * normalized via the layout-scale viewport, never this — so high-res rendering
 * and coordinate stability stay orthogonal.
 */
export function bitmapScale(layoutScale: number, dpr: number): number {
  const s = clampZoom(layoutScale) * Math.max(1, dpr || 1);
  return Math.min(MAX_RENDER_SCALE, s);
}

/** Clamp a page index into [0, count-1]. */
export function clampPage(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.max(0, Math.trunc(index)));
}
