import { clampZoom, type FitMode } from "./viewer";

/**
 * Blueprint Revision Comparison (Programme D) — pure logic. No DOM, no fetch;
 * unit-testable under vitest's node env. The comparison itself is a pure
 * application-side composition over the existing version chain + the RLS-gated
 * /f/[versionId] serve route (zero migration). This module owns: revision-pair
 * defaults, deterministic page pairing, overlay dimension-compatibility, the
 * shared normalized view state, and URL-state (de)serialization.
 */

export const COMPARE_MODES = ["side", "overlay", "diff"] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];
export const COMPARE_MODE_LABELS: Record<CompareMode, string> = {
  side: "Side by side", overlay: "Overlay", diff: "Difference",
};

/** A revision as the picker/compare needs it (subset of blueprint_versions). */
export type CompareVersion = {
  id: string;
  version: number; // internal chain order (higher = newer)
  revision: string; // human label
  revision_date: string | null;
  uploaded_at: string | null;
  mime_type: string;
};

/** Which annotation layers are visible. Compare defaults to drawings-only. */
export type AnnToggles = { aPins: boolean; bPins: boolean; aMarkup: boolean; bMarkup: boolean };
export const NO_ANNOTATIONS: AnnToggles = { aPins: false, bPins: false, aMarkup: false, bMarkup: false };

export type CompareState = {
  a: string; // versionId A (baseline / older)
  b: string; // versionId B (current / newer)
  mode: CompareMode;
  pageA: number; // 1-based
  pageB: number; // 1-based
  opacity: number; // 0..1, foreground (B) in overlay/diff
  sync: boolean;
  fg: "a" | "b"; // which revision is the overlay foreground
  ann: AnnToggles;
};

/** Shared view transform driven across both surfaces when sync is on. */
export type CompareView = { fit: FitMode; zoom: number; pan: { x: number; y: number } };
export const DEFAULT_COMPARE_VIEW: CompareView = { fit: "page", zoom: 1, pan: { x: 0, y: 0 } };

// ── revision selection (§13) ─────────────────────────────────────────────────
/**
 * Default pair = current vs immediately-previous. `versions` is the chain in
 * version-DESC order (as the register loads it): [0] = current, [1] = previous.
 * Returns null if fewer than two versions (nothing to compare).
 */
export function defaultRevisionPair(versions: readonly CompareVersion[]): { a: string; b: string } | null {
  if (versions.length < 2) return null;
  return { a: versions[1]!.id, b: versions[0]!.id }; // A = previous (baseline), B = current
}

/** True when the two ids are distinct + both present in the chain (A==B is a no-op). */
export function isValidPair(versions: readonly CompareVersion[], a: string, b: string): boolean {
  if (a === b) return false;
  const ids = new Set(versions.map((v) => v.id));
  return ids.has(a) && ids.has(b);
}

// ── page pairing (§12) ───────────────────────────────────────────────────────
export const clampPageNum = (n: number, count: number): number =>
  Math.min(Math.max(1, Math.floor(Number.isFinite(n) ? n : 1)), Math.max(1, count));

/** Seed a page pair by same-index when counts match; else clamp within each. */
export function seedPagePair(pageA: number, pageB: number, countA: number, countB: number): { pageA: number; pageB: number } {
  return { pageA: clampPageNum(pageA, countA), pageB: clampPageNum(pageB, countB) };
}

export const pageCountsDiffer = (countA: number, countB: number): boolean => countA !== countB;

// ── overlay dimension compatibility (§10) ────────────────────────────────────
export const OVERLAY_ASPECT_TOL = 0.01; // 1% relative aspect drift

/** Relative, symmetric aspect drift between two page boxes. 0 = identical shape. */
export function aspectDrift(a: { w: number; h: number }, b: { w: number; h: number }): number {
  const aa = a.w / a.h, ab = b.w / b.h;
  if (!Number.isFinite(aa) || !Number.isFinite(ab) || aa <= 0 || ab <= 0) return Infinity;
  return Math.abs(aa - ab) / Math.min(aa, ab);
}

/** Overlay/difference are honest only when the two sheets share an aspect ratio. */
export function overlayAllowed(a: { w: number; h: number }, b: { w: number; h: number }, tol = OVERLAY_ASPECT_TOL): boolean {
  return aspectDrift(a, b) <= tol;
}

// ── misc clamps ──────────────────────────────────────────────────────────────
export const clampOpacity = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);

// ── URL state (§15) — validate everything, graceful fallback ─────────────────
export function parseCompareState(
  params: Record<string, string | undefined>,
  versions: readonly CompareVersion[],
): CompareState | null {
  const def = defaultRevisionPair(versions);
  if (!def) return null;
  let a = params.a ?? def.a;
  let b = params.b ?? def.b;
  if (!isValidPair(versions, a, b)) { a = def.a; b = def.b; } // bad/tampered pair → safe default
  const mode: CompareMode = (COMPARE_MODES as readonly string[]).includes(params.mode ?? "") ? (params.mode as CompareMode) : "side";
  const num = (s: string | undefined, d: number) => { const n = Number(s); return Number.isFinite(n) ? n : d; };
  const ann = parseAnn(params.ann);
  return {
    a, b, mode,
    pageA: clampPageNum(num(params.pageA, 1), Number.MAX_SAFE_INTEGER),
    pageB: clampPageNum(num(params.pageB, 1), Number.MAX_SAFE_INTEGER),
    opacity: clampOpacity(num(params.op, 0.5)),
    sync: params.sync !== "0",
    fg: params.fg === "a" ? "a" : "b",
    ann,
  };
}

function parseAnn(s: string | undefined): AnnToggles {
  if (!s) return { ...NO_ANNOTATIONS };
  const set = new Set(s.split(",").map((x) => x.trim()));
  return { aPins: set.has("ap"), bPins: set.has("bp"), aMarkup: set.has("am"), bMarkup: set.has("bm") };
}

export function serializeAnn(ann: AnnToggles): string {
  return [ann.aPins && "ap", ann.bPins && "bp", ann.aMarkup && "am", ann.bMarkup && "bm"].filter(Boolean).join(",");
}

/** Compare deep-link query for the register route (UUIDs only — no signed URLs/paths). */
export function compareSearch(blueprintId: string, s: CompareState): string {
  const p = new URLSearchParams({
    compare: blueprintId, a: s.a, b: s.b, mode: s.mode,
    pageA: String(s.pageA), pageB: String(s.pageB), op: String(s.opacity),
    sync: s.sync ? "1" : "0", fg: s.fg,
  });
  const ann = serializeAnn(s.ann);
  if (ann) p.set("ann", ann);
  return `?${p.toString()}`;
}

/** Accessible summary announced to screen readers on open/mode change (§18). */
export function compareSummary(a: CompareVersion | undefined, b: CompareVersion | undefined, mode: CompareMode): string {
  const rev = (v: CompareVersion | undefined) => (v ? `${v.revision}${v.revision_date ? ` (issued ${v.revision_date})` : ""}` : "—");
  return `${COMPARE_MODE_LABELS[mode]}. Comparing revision ${rev(a)} with revision ${rev(b)}.`;
}

export { clampZoom };
