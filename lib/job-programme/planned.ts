import { daysBetween } from "@/lib/schedule/window";
import {
  buildProgressCurve,
  type CurveOptions,
  type ProgressPoint,
} from "@/lib/job-progress/series";

/**
 * Job programme — the PLANNED line (PURE).
 *
 * This module OWNS NO DATA and performs NO I/O. It takes the current programme
 * baseline and its milestones (fetched, org-pinned and job-pinned, by
 * server/services/job-progress.ts) and turns them into the planned
 * cumulative-progress curve that sits beside the ACTUAL curve from
 * lib/job-progress/series.ts. Same split, same reason: every rule about what
 * the planned line may claim is unit-testable without a database.
 *
 * ── NEVER A FABRICATED LINE ────────────────────────────────────────────────
 * series.ts refused to invent a planned baseline when none existed, and that
 * refusal DOES NOT relax now that one can: this module emits a curve ONLY when
 *
 *   1. a CURRENT baseline exists (superseded_at IS NULL — the caller's query),
 *   2. it has at least one milestone, and
 *   3. EVERY milestone carries a weight and the weights sum to 100 (±0.01,
 *      the same tolerance set_job_programme enforces at write time).
 *
 * Anything less returns NULL. A straight 0→100 line drawn through an
 * unweighted programme would be exactly the fabrication the old panel copy
 * warned about — it would make every variance figure a lie that looks like
 * evidence. An unweighted programme still shows its window and milestone list
 * in the programme panel; it just earns no curve until someone says what each
 * milestone is worth.
 *
 * ── THE SHAPE OF THE LINE ──────────────────────────────────────────────────
 * Piecewise-linear cumulative weight:
 *
 *   (planned_start, 0) → each milestone's (planned_end, Σ weights so far,
 *   in DATE order) → (planned_end, 100)
 *
 * Vertices are merged per day (two milestones finishing the same day are one
 * step of their combined weight), and ordering is by day key — never by input
 * row order — so the output is identical for any permutation of the rows.
 *
 * NO MONEY. A weight is a dimensionless share of the programme. Nothing here
 * imports lib/finances, lib/commercial, lib/invoices or lib/billing, and no
 * output field could carry an amount — the 20261078 decision-4 boundary,
 * swept by __tests__/security/job-programme-no-fabrication.test.ts.
 *
 * Dates are `YYYY-MM-DD` Europe/London day keys throughout; arithmetic is
 * lib/schedule/window's `daysBetween` (never toISOString day maths).
 */

// ── Input rows (exactly the columns the service selects) ─────────────────────

export interface ProgrammeBaselineRow {
  id: string;
  revision: number;
  planned_start: string;
  planned_end: string;
}

export interface ProgrammeMilestoneRow {
  id: string;
  title: string;
  planned_start: string | null;
  planned_end: string;
  /** numeric(5,2) arrives as a string from PostgREST. */
  weight: number | string | null;
  customer_visible: boolean;
  sort: number;
}

// ── Output ───────────────────────────────────────────────────────────────────

/** One vertex of the planned line: a day and the percent planned BY that day. */
export interface PlannedPoint {
  day: string;
  percent: number;
}

/** The planned line's chart geometry, in the SAME viewBox as the actual curve. */
export interface PlannedCurve {
  points: Array<PlannedPoint & { x: number; y: number }>;
  /** SVG polyline `points` attribute. */
  polyline: string;
}

/** Write-time tolerance on Σ weights, mirrored at read time. */
export const WEIGHT_SUM_TOLERANCE = 0.01;

// ── Reading a weight safely ──────────────────────────────────────────────────

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Coerce a stored weight to a positive number ≤ 100, or null. Out-of-range and
 * unparseable values are DROPPED (which nulls the whole curve via the
 * all-or-none rule) rather than clamped — clamping would invent a share.
 */
export function readWeight(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return null;
  if (n <= 0 || n > 100) return null;
  return n;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── The planned series ───────────────────────────────────────────────────────

/**
 * The planned cumulative curve, or NULL when there is no honest one to emit.
 *
 * Null when: no baseline; malformed or inverted baseline window; no
 * milestones; any milestone day malformed or outside the window; any weight
 * missing (all-or-none); or Σ weights outside 100 ± tolerance. Every null is a
 * refusal to fabricate, never an error state — the caller renders the actual
 * curve alone, exactly as it does today.
 */
export function buildPlannedProgress(
  baseline: ProgrammeBaselineRow | null | undefined,
  milestones: readonly ProgrammeMilestoneRow[],
): PlannedPoint[] | null {
  if (!baseline) return null;
  const start = baseline.planned_start;
  const end = baseline.planned_end;
  if (!DAY_KEY.test(start ?? "") || !DAY_KEY.test(end ?? "")) return null;
  if (end < start) return null;
  if (milestones.length === 0) return null;

  // Weight per day, merged. Any unusable row nulls the curve outright — a
  // vertex silently dropped would bend the planned line toward a lie.
  const weightByDay = new Map<string, number>();
  for (const m of milestones) {
    const day = typeof m.planned_end === "string" ? m.planned_end.trim() : "";
    if (!DAY_KEY.test(day)) return null;
    if (day < start || day > end) return null;
    const weight = readWeight(m.weight);
    if (weight === null) return null; // unweighted or partial → no curve
    weightByDay.set(day, (weightByDay.get(day) ?? 0) + weight);
  }

  let sum = 0;
  for (const w of weightByDay.values()) sum += w;
  if (Math.abs(sum - 100) > WEIGHT_SUM_TOLERANCE) return null;

  const days = [...weightByDay.keys()].sort();
  const points: PlannedPoint[] = [{ day: start, percent: 0 }];
  let cumulative = 0;
  for (const day of days) {
    cumulative += weightByDay.get(day)!;
    points.push({ day, percent: round2(Math.min(100, cumulative)) });
  }
  // The line always lands on (planned_end, 100). When the last milestone
  // already sits there at (tolerated) 100 this is a duplicate, not new truth.
  const last = points[points.length - 1]!;
  if (last.day !== end || last.percent !== 100) {
    if (last.day === end && Math.abs(last.percent - 100) <= WEIGHT_SUM_TOLERANCE) {
      last.percent = 100;
    } else {
      points.push({ day: end, percent: 100 });
    }
  }
  return points;
}

// ── Domain union ─────────────────────────────────────────────────────────────

export interface CurveDomain {
  from: string;
  to: string;
}

/**
 * The x-domain covering BOTH lines. Day keys compare lexicographically, so
 * min/max is a string comparison. Null only when both sides are null.
 */
export function unionDomain(
  a: CurveDomain | null,
  b: CurveDomain | null,
): CurveDomain | null {
  if (!a) return b;
  if (!b) return a;
  return {
    from: a.from < b.from ? a.from : b.from,
    to: a.to > b.to ? a.to : b.to,
  };
}

/** The day span of a planned series, for `unionDomain`. */
export function plannedDomain(points: readonly PlannedPoint[]): CurveDomain | null {
  if (points.length === 0) return null;
  return { from: points[0]!.day, to: points[points.length - 1]!.day };
}

// ── Geometry ─────────────────────────────────────────────────────────────────

/**
 * Lay the planned vertices out in chart coordinates.
 *
 * DELIBERATELY DELEGATES to series.ts's `buildProgressCurve` rather than
 * re-implementing the mapping: one x/y formula means the planned and actual
 * lines can never disagree about where a day or a percentage sits on screen.
 * The caller passes the SAME width/height/padding and the SAME (union) domain
 * it used for the actual curve. The adapter points below exist only to satisfy
 * the input type; none of their filler fields reaches the output.
 */
export function buildPlannedCurve(
  points: readonly PlannedPoint[],
  options: CurveOptions = {},
): PlannedCurve {
  const adapted: ProgressPoint[] = points.map((p, i) => ({
    day: p.day,
    percent: p.percent,
    source: "observation",
    sourceId: `planned-${i}`,
    note: null,
    authorId: null,
    reference: null,
  }));
  const curve = buildProgressCurve(adapted, options);
  return {
    points: curve.points.map((p) => ({
      day: p.day,
      percent: p.percent,
      x: p.x,
      y: p.y,
    })),
    polyline: curve.polyline,
  };
}

// ── Variance-free by design ──────────────────────────────────────────────────
// No function here compares planned with actual, and none may without a CEO
// decision: "X% behind programme" shown to a customer is a commercial claim
// (see lib/job-progress/portal.ts on publishing verdicts). The two lines are
// drawn side by side; the reader draws the conclusion.

/** Days between two day keys, re-exported convenience for the panel copy. */
export function programmeLengthDays(baseline: ProgrammeBaselineRow): number {
  return daysBetween(baseline.planned_start, baseline.planned_end);
}
