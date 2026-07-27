import { z } from "zod";
import { clamp01, type Norm } from "./viewer";
export type { Norm } from "./viewer";

/**
 * Blueprint Markup (Programme C) — pure geometry + schemas.
 *
 * Reuses the pins/M2 coordinate model verbatim: a markup shape is a list of
 * normalized {u,v} anchor points in [0,1] of the page box (top-left origin,
 * v-down), stable across zoom/pan/DPR/resize. Rendered in an SVG with
 * viewBox="0 0 1 1" preserveAspectRatio="none", so u→x, v→y is a no-op at paint.
 * No DOM imports — every function is unit-testable under vitest's node env.
 *
 * `MARKUP_KINDS` is the source of truth the migration's CHECK must mirror.
 */

// ── kinds ────────────────────────────────────────────────────────────────────
export const MARKUP_KINDS = ["freehand", "line", "arrow", "rect", "ellipse", "text"] as const;
export type MarkupKind = (typeof MARKUP_KINDS)[number];
export const MARKUP_KIND_LABELS: Record<MarkupKind, string> = {
  freehand: "Freehand", line: "Line", arrow: "Arrow",
  rect: "Rectangle", ellipse: "Ellipse", text: "Text",
};

// ── geom ─────────────────────────────────────────────────────────────────────
export type MarkupGeom = { kind: MarkupKind; points: readonly Norm[] };
export type Bbox = { u: number; v: number; w: number; h: number };

export const MARKUP_ARITY: Record<MarkupKind, { min: number; max: number }> = {
  freehand: { min: 2, max: 512 },
  line: { min: 2, max: 2 }, arrow: { min: 2, max: 2 },
  rect: { min: 2, max: 2 }, ellipse: { min: 2, max: 2 },
  text: { min: 1, max: 1 },
};

// ── tuning constants (normalized space — resolution/zoom/DPR independent) ─────
export const FREEHAND_EPSILON = 0.002;   // RDP tolerance ≈ 0.2% of the larger side
export const MAX_FREEHAND_POINTS = 512;  // hard stored cap
export const MIN_CAPTURE_DELTA = 0.001;  // drop sub-pixel jitter before RDP
export const MIN_SHAPE_SPAN = 0.005;     // a 2-point shape below this is a mis-tap
const QUANTUM = 1e5;                     // quantise coords so client+server bbox agree

/** Snap a coord to a fixed grid so client-preview and the DB trigger derive the
 * same bbox bit-for-bit (both run IEEE-754 min/max on identical inputs). */
export const quantize = (n: number): number => Math.round(clamp01(n) * QUANTUM) / QUANTUM;
export const quantizePoints = (pts: readonly Norm[]): Norm[] => pts.map((p) => ({ u: quantize(p.u), v: quantize(p.v) }));

/** Normalized (u,v) → CSS percentage anchor (for pixel-space text/arrowheads/handles). */
export function normalizedToPercent(n: Norm): { left: string; top: string } {
  return { left: `${clamp01(n.u) * 100}%`, top: `${clamp01(n.v) * 100}%` };
}

/** Axis-aligned bounding box of the points. u,v = min corner; w,h = span. */
export function bbox(points: readonly Norm[]): Bbox {
  const first = points[0];
  if (!first) return { u: 0, v: 0, w: 0, h: 0 };
  let minU = first.u, maxU = first.u, minV = first.v, maxV = first.v;
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    if (p.u < minU) minU = p.u; else if (p.u > maxU) maxU = p.u;
    if (p.v < minV) minV = p.v; else if (p.v > maxV) maxV = p.v;
  }
  return { u: minU, v: minV, w: maxU - minU, h: maxV - minV };
}

// ── freehand simplification (iterative RDP — no recursion overflow) ───────────
function perpDist(p: Norm, a: Norm, b: Norm): number {
  const du = b.u - a.u, dv = b.v - a.v;
  const len2 = du * du + dv * dv;
  if (len2 === 0) return Math.hypot(p.u - a.u, p.v - a.v);
  const cross = Math.abs(du * (p.v - a.v) - dv * (p.u - a.u));
  return cross / Math.sqrt(len2);
}

/** Ramer–Douglas–Peucker, iterative (heap stack) so long strokes can't overflow. */
export function simplify(points: readonly Norm[], epsilon: number): Norm[] {
  const n = points.length;
  if (n <= 2 || epsilon <= 0) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    if (hi - lo < 2) continue;
    const a = points[lo]!, b = points[hi]!;
    let maxD = -1, idx = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDist(points[i]!, a, b);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > epsilon && idx !== -1) { keep[idx] = 1; stack.push([lo, idx], [idx, hi]); }
  }
  const out: Norm[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]!);
  return out;
}

/** Endpoint-preserving uniform decimation — the hard-cap fallback after RDP. */
function decimate(points: readonly Norm[], max: number): Norm[] {
  const n = points.length;
  if (n <= max) return points.slice();
  const out: Norm[] = [points[0]!];
  const step = (n - 1) / (max - 1);
  for (let i = 1; i < max - 1; i++) out.push(points[Math.round(i * step)]!);
  out.push(points[n - 1]!);
  return out;
}

/** Capture → storage: RDP then guarantee the hard point cap. */
export function simplifyStroke(raw: readonly Norm[], epsilon = FREEHAND_EPSILON, max = MAX_FREEHAND_POINTS): Norm[] {
  const s = simplify(raw, epsilon);
  return s.length <= max ? s : decimate(s, max);
}

/** Append a freehand sample, skipping sub-MIN_CAPTURE_DELTA jitter. Pure. */
export function appendSample(path: readonly Norm[], next: Norm, minDelta = MIN_CAPTURE_DELTA): Norm[] {
  const last = path[path.length - 1];
  if (last && Math.hypot(next.u - last.u, next.v - last.v) < minDelta) return path as Norm[];
  return [...path, next];
}

// ── validation predicates (pure) ─────────────────────────────────────────────
export function isValidPointCount(kind: MarkupKind, count: number): boolean {
  const a = MARKUP_ARITY[kind];
  return Number.isInteger(count) && count >= a.min && count <= a.max;
}
const inUnit = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;
export function hasValidPoints(geom: MarkupGeom): boolean {
  return isValidPointCount(geom.kind, geom.points.length) && geom.points.every((p) => inUnit(p.u) && inUnit(p.v));
}
/** A 2-point shape whose span is below a tap — an accidental zero-size drag. */
export function isDegenerate(geom: MarkupGeom): boolean {
  if (geom.kind === "text") return false;
  const b = bbox(geom.points);
  return Math.hypot(b.w, b.h) < MIN_SHAPE_SPAN;
}

// ── the row shape the UI consumes ────────────────────────────────────────────
export type BlueprintMarkup = {
  id: string;
  blueprint_version_id: string;
  page_number: number; // 1-based (same convention as pins)
  kind: MarkupKind;
  points: Norm[];
  color: string | null;
  text: string | null;
  stroke_width: number | null;
  created_at: string;
  created_by: string | null;
};

/** Markup on the sheet the viewer currently shows (its `page` is 0-based). */
export function markupForSheet<T extends { page_number: number }>(rows: readonly T[], zeroBasedPage: number): T[] {
  const want = Math.max(1, Math.floor(zeroBasedPage) + 1);
  return rows.filter((m) => m.page_number === want);
}

// ── input schema (server actions validate against this) ──────────────────────
const coord = z.number().min(0).max(1);
const normPoint = z.object({ u: coord, v: coord });
export const markupGeomSchema = z
  .object({ kind: z.enum(MARKUP_KINDS), points: z.array(normPoint).min(1).max(MAX_FREEHAND_POINTS) })
  .refine((g) => isValidPointCount(g.kind, g.points.length), { message: "wrong number of points for this shape", path: ["points"] });

export const createMarkupSchema = z
  .object({
    blueprint_version_id: z.string().uuid(),
    page_number: z.number().int().min(1),
    geom: markupGeomSchema,
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "colour must be a hex code").optional(),
    text: z.string().trim().max(500).optional().or(z.literal("").transform(() => undefined)),
    stroke_width: z.number().min(0.5).max(24).optional(),
  })
  .refine((m) => (m.geom.kind === "text" ? !!m.text : true), { message: "text markup needs some text", path: ["text"] });
export type CreateMarkupInput = z.infer<typeof createMarkupSchema>;

export const deleteMarkupSchema = z.object({ id: z.string().uuid() });
