import { formatDayKeyUK } from "@/lib/time/format";
import { daysBetween } from "@/lib/schedule/window";

/**
 * Job progress — the SERIES, the TREND and the CURVE (PURE).
 *
 * This module OWNS NO DATA and performs NO I/O. It takes rows the caller already
 * fetched (RLS-scoped, org-pinned and job-pinned by
 * server/services/job-progress.ts) and turns them into a time series, a trend
 * verdict and the geometry of a chart. Same split as lib/site-ops/timeline.ts,
 * for the same reason: every merge, precedence and threshold rule becomes
 * unit-testable without a database.
 *
 * ── ONE SOURCE OF TRUTH ────────────────────────────────────────────────────
 * A job's progress figures live in TWO places, and this module is where they
 * meet — by READING both, never by copying one into the other:
 *
 *   1. `job_progress_observations` (20261078) — deliberate, dated, job-level
 *      assessments. The primary path.
 *   2. `site_reports.content.progress_percent` — the figure that already ships
 *      inside formal client reports and is already shown in the customer
 *      portal.
 *
 * The migration deliberately cannot store (2): no source column, no report_id.
 * So the union happens HERE, at read time, and a report figure corrected by its
 * author is corrected in the series on the next render. There is no copy to go
 * stale and no reconciliation job to forget to run.
 *
 * ── NO PLANNED BASELINE ────────────────────────────────────────────────────
 * This module models ACTUAL progress only. CrewFlow holds no programme: `jobs`
 * has one `scheduled_date` (a calendar booking, with no matching end date) and
 * a `practical_completion_date` that is the ACTUAL completion recorded after
 * the fact. Drawing a straight 0→100 line between invented endpoints and
 * calling it "planned" would make every variance figure a fabrication, so no
 * function here emits one. `buildProgressCurve` returns the actual line and
 * nothing else; when a real baseline table exists it becomes a second input,
 * not a change to this one.
 *
 * ── NOT A VALUATION ────────────────────────────────────────────────────────
 * Nothing here touches money. There is no amount type, no currency, no import
 * from lib/finances, lib/commercial, lib/invoices or lib/billing, and no output
 * field a valuation could hide in. Percent-complete must never become a billing
 * trigger — staged billing already exists and owns that job.
 *
 * Dates are Europe/London throughout, via lib/time/format's `formatDayKeyUK`
 * and lib/schedule/window's `daysBetween`. No date helper is defined here.
 */

// ── Point + source ───────────────────────────────────────────────────────────

/** Where a point in the series came from. */
export type ProgressSource = "observation" | "site_report";

/**
 * Site-report statuses whose progress figure ENTERS the series.
 *
 * Reasoned per status rather than "anything non-draft":
 *   - `draft`       EXCLUDED. Still being typed; `content` is mutable until
 *                   issue, so a half-finished figure is not an observation.
 *   - `superseded`  EXCLUDED. A later revision replaced it, and both revisions
 *                   share a `period_end` — including the pair would put two
 *                   contradictory readings on the same day for the same period.
 *   - `archived`    EXCLUDED. Withdrawn; it is not the org's current account of
 *                   that period.
 *   - the rest      INCLUDED: the figure has at least been put forward.
 */
export const REPORTED_PROGRESS_STATUSES = [
  "ready_for_review",
  "approved",
  "issued",
] as const;

/** A single reading in the series: one day, one percentage, one origin. */
export interface ProgressPoint {
  /** Europe/London calendar day, `YYYY-MM-DD`. The x value. */
  day: string;
  /** 0–100 inclusive. The y value. */
  percent: number;
  source: ProgressSource;
  /** Primary key of the owning row (observation id / report id). */
  sourceId: string;
  /**
   * INTERNAL note. Observation-only, always null for a report point.
   * MUST NOT reach a customer — see lib/job-progress/portal.ts.
   */
  note: string | null;
  /** INTERNAL author id. Same customer-boundary rule as `note`. */
  authorId: string | null;
  /** Provenance for staff display ("Report SR-0004"). Null for observations. */
  reference: string | null;
}

// ── Input rows (exactly the columns the service selects) ─────────────────────

export type ProgressObservationRow = {
  id: string;
  observed_on: string;
  percent: number | string;
  note: string | null;
  recorded_by: string | null;
};

export type SiteReportProgressRow = {
  id: string;
  status: string;
  period_end: string;
  report_number: string | null;
  content: unknown;
};

// ── Reading a percentage safely ──────────────────────────────────────────────

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Coerce a stored percentage into an integer 0–100, or null.
 *
 * Mirrors the validation `site_reports.content.progress_percent` is written
 * through (lib/site-reports/schema.ts: coerce → int → min 0 → max 100), so a
 * figure means the same thing on both sides of the union. Rounding is applied
 * rather than rejection for an in-range non-integer, because `content` is free
 * jsonb that predates the current schema and a legacy 62.5 is a real reading;
 * anything out of range or unparseable is DROPPED rather than clamped —
 * clamping 400% to 100% would invent a fact.
 */
export function readPercent(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 100) return null;
  return Math.round(n);
}

/** Pull `progress_percent` out of a site report's `content` jsonb. */
export function readReportPercent(content: unknown): number | null {
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  return readPercent((content as Record<string, unknown>).progress_percent);
}

/** Normalise a stored date to a `YYYY-MM-DD` day key, or null if unusable. */
function dayKey(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (DAY_KEY.test(raw)) return raw;
  // A timestamptz (or anything else parseable) is filed under its LONDON day,
  // matching how lib/site-ops/timeline.ts buckets every other site event.
  const key = formatDayKeyUK(raw);
  return DAY_KEY.test(key) ? key : null;
}

// ── Building the series ──────────────────────────────────────────────────────

export interface ProgressSeriesInput {
  observations?: readonly ProgressObservationRow[];
  reports?: readonly SiteReportProgressRow[];
}

/**
 * Merge both sources into ONE reading per day, OLDEST FIRST.
 *
 * COLLISION RULE — a manual observation BEATS a site-report figure for the same
 * day. The observation is the record whose only purpose is this series, it is
 * the one a user can see and correct on the progress panel, and it is the more
 * specific act (someone assessed the job) versus a by-product of writing a
 * document. The rule is applied here, once, so no renderer has to know it.
 *
 * Rows with an unusable date or percentage are SKIPPED, never defaulted: one
 * malformed legacy report must not blank a job's whole curve, and inventing a
 * 0 for it would bend the line toward a lie.
 *
 * Deterministic and permutation-independent: the day key is the map key, the
 * ordering is a total order on unique day keys, and the collision rule depends
 * only on `source`. Two reports colliding on a day (possible only across
 * different periods sharing a `period_end`) resolve by the lexicographically
 * smaller id, so the output never depends on PostgREST's row order.
 */
export function buildProgressSeries(input: ProgressSeriesInput): ProgressPoint[] {
  const byDay = new Map<string, ProgressPoint>();

  for (const r of input.reports ?? []) {
    if (!(REPORTED_PROGRESS_STATUSES as readonly string[]).includes(r.status)) continue;
    const day = dayKey(r.period_end);
    const percent = readReportPercent(r.content);
    if (day === null || percent === null) continue;
    const existing = byDay.get(day);
    // Stable tiebreak between two reports on one day (see header).
    if (existing && existing.source === "site_report" && existing.sourceId <= r.id) continue;
    byDay.set(day, {
      day,
      percent,
      source: "site_report",
      sourceId: r.id,
      note: null,
      authorId: null,
      reference: r.report_number,
    });
  }

  for (const o of input.observations ?? []) {
    const day = dayKey(o.observed_on);
    const percent = readPercent(o.percent);
    if (day === null || percent === null) continue;
    const existing = byDay.get(day);
    // An observation always displaces a report; between two observations (which
    // the unique (job_id, observed_on) key makes impossible in practice) the
    // smaller id wins, so the result is still order-independent.
    if (existing && existing.source === "observation" && existing.sourceId <= o.id) continue;
    byDay.set(day, {
      day,
      percent,
      source: "observation",
      sourceId: o.id,
      note: o.note,
      authorId: o.recorded_by,
      reference: null,
    });
  }

  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

// ── Trend ────────────────────────────────────────────────────────────────────

/**
 * How the job is moving.
 *
 *   none        — nothing recorded yet.
 *   first       — exactly one reading: a starting point, not yet a direction.
 *   progressing — the last move was UP and the series is fresh.
 *   stalled     — the last move was FLAT, or the series has gone quiet.
 *   regressed   — the last move was DOWN (rework, a failed inspection, a
 *                 re-measure). A first-class outcome, never suppressed.
 */
export type ProgressTrend = "none" | "first" | "progressing" | "stalled" | "regressed";

/** The word shown on the badge — the trend is never carried by colour alone (WCAG 1.4.1). */
export const PROGRESS_TREND_LABELS: Record<ProgressTrend, string> = {
  none: "No progress recorded",
  first: "First reading",
  progressing: "Progressing",
  stalled: "Stalled",
  regressed: "Went backwards",
};

/**
 * How many days of silence make a series STALE.
 *
 * Weekly reporting is the UK site norm, so a fortnight without a reading means
 * the number on screen is no longer evidence of anything. Overridable per call
 * so a caller can tighten it; never read from a clock or an env var here.
 */
export const PROGRESS_STALE_AFTER_DAYS = 14;

export interface ProgressSummary {
  /** The merged series, oldest first. */
  points: ProgressPoint[];
  /** Most recent reading, or null. */
  latest: ProgressPoint | null;
  /** The reading before `latest`, or null. */
  previous: ProgressPoint | null;
  /** Latest percentage, or null when nothing is recorded. */
  percent: number | null;
  /** latest − previous. Negative on a regression. Null with fewer than 2 points. */
  delta: number | null;
  trend: ProgressTrend;
  /** Whole London days from the latest reading to `now`. Null when empty. */
  daysSinceUpdate: number | null;
  /** True once `daysSinceUpdate` exceeds the threshold. */
  stale: boolean;
  /** Days covered by the series (first → last reading). Null when empty. */
  spanDays: number | null;
}

/**
 * Summarise a series into the four things a site manager actually asks:
 * where are we, which way is it moving, when did anyone last say, and is that
 * recent enough to believe.
 *
 * `now` is injected (never `new Date()` here) so every output is reproducible
 * in a test and consistent with the day the page rendered for.
 *
 * PRECEDENCE — `regressed` outranks `stalled`. If a job went backwards and then
 * went quiet, "went backwards" is the fact that needs acting on; staleness is
 * not hidden by this, because `daysSinceUpdate` and `stale` are always returned
 * alongside and the UI shows "last updated …" unconditionally.
 */
export function summariseProgress(
  points: readonly ProgressPoint[],
  now: Date,
  options: { staleAfterDays?: number } = {},
): ProgressSummary {
  const staleAfter = options.staleAfterDays ?? PROGRESS_STALE_AFTER_DAYS;
  const ordered = [...points];
  const latest = ordered[ordered.length - 1] ?? null;
  const previous = ordered.length >= 2 ? (ordered[ordered.length - 2] ?? null) : null;

  if (!latest) {
    return {
      points: ordered,
      latest: null,
      previous: null,
      percent: null,
      delta: null,
      trend: "none",
      daysSinceUpdate: null,
      stale: false,
      spanDays: null,
    };
  }

  const today = formatDayKeyUK(now);
  // A future-dated reading cannot make "days since" negative — the DB refuses
  // future observations, but a report's period_end is not so constrained.
  const daysSinceUpdate = Math.max(0, daysBetween(latest.day, today));
  const stale = daysSinceUpdate > staleAfter;
  const delta = previous ? latest.percent - previous.percent : null;

  let trend: ProgressTrend;
  if (delta === null) trend = "first";
  else if (delta < 0) trend = "regressed";
  else if (stale) trend = "stalled";
  else if (delta === 0) trend = "stalled";
  else trend = "progressing";

  const first = ordered[0];
  return {
    points: ordered,
    latest,
    previous,
    percent: latest.percent,
    delta,
    trend,
    daysSinceUpdate,
    stale,
    spanDays: first ? Math.max(0, daysBetween(first.day, latest.day)) : null,
  };
}

// ── Curve geometry ───────────────────────────────────────────────────────────

export interface CurvePoint extends ProgressPoint {
  /** Horizontal position in viewBox units. */
  x: number;
  /** Vertical position in viewBox units (SVG y grows DOWNWARD). */
  y: number;
}

export interface ProgressCurve {
  points: CurvePoint[];
  /** `points` as an SVG polyline `points` attribute. Empty when there is none. */
  polyline: string;
  /** Closed path under the line, for the area fill. Empty when fewer than 2 points. */
  areaPath: string;
  width: number;
  height: number;
  /** Gridline positions (viewBox y) for 0/25/50/75/100%. */
  gridlines: Array<{ percent: number; y: number }>;
  /** First and last day in the series, for the axis labels. */
  domain: { from: string; to: string } | null;
}

export interface CurveOptions {
  width?: number;
  height?: number;
  padding?: { top?: number; right?: number; bottom?: number; left?: number };
}

/**
 * Turn the series into chart geometry.
 *
 * Kept PURE and in the lib (not in the component) so the shape of the line is
 * unit-testable and identical everywhere it is drawn — and so no charting
 * dependency is needed. The repo has none (checked: no recharts / chart.js / d3
 * / visx / nivo / echarts / plotly in package.json), and a progress line is ~30
 * lines of coordinates; adding a library to draw it would repeat the 48 kB
 * animation-library rejection.
 *
 * Y IS ALWAYS THE FULL 0–100 DOMAIN, never auto-scaled to the data. Auto-scaling
 * a percentage is a way to lie with a chart: a 58→61% fortnight would fill the
 * panel and read as a surge. The slope on screen is the slope in reality.
 *
 * X is the observed day span. A single reading has no span, so it is CENTRED
 * (rendered as a lone dot) rather than pinned to the left edge, where it reads
 * as a clipped chart.
 */
export function buildProgressCurve(
  points: readonly ProgressPoint[],
  options: CurveOptions = {},
): ProgressCurve {
  const width = options.width ?? 320;
  const height = options.height ?? 120;
  const padTop = options.padding?.top ?? 8;
  const padRight = options.padding?.right ?? 8;
  const padBottom = options.padding?.bottom ?? 8;
  const padLeft = options.padding?.left ?? 8;

  const innerW = Math.max(1, width - padLeft - padRight);
  const innerH = Math.max(1, height - padTop - padBottom);

  // Fixed percentage domain (see header).
  const yFor = (percent: number) => padTop + innerH * (1 - percent / 100);
  const round = (n: number) => Math.round(n * 100) / 100;

  const gridlines = [0, 25, 50, 75, 100].map((percent) => ({
    percent,
    y: round(yFor(percent)),
  }));

  if (points.length === 0) {
    return {
      points: [],
      polyline: "",
      areaPath: "",
      width,
      height,
      gridlines,
      domain: null,
    };
  }

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const span = daysBetween(first.day, last.day);

  const curvePoints: CurvePoint[] = points.map((p) => {
    const x =
      span <= 0
        ? padLeft + innerW / 2
        : padLeft + innerW * (daysBetween(first.day, p.day) / span);
    return { ...p, x: round(x), y: round(yFor(p.percent)) };
  });

  const polyline = curvePoints.map((p) => `${p.x},${p.y}`).join(" ");
  const baseline = round(yFor(0));
  const areaPath =
    curvePoints.length >= 2
      ? `M ${curvePoints[0]!.x} ${baseline} ` +
        curvePoints.map((p) => `L ${p.x} ${p.y}`).join(" ") +
        ` L ${curvePoints[curvePoints.length - 1]!.x} ${baseline} Z`
      : "";

  return {
    points: curvePoints,
    polyline,
    areaPath,
    width,
    height,
    gridlines,
    domain: { from: first.day, to: last.day },
  };
}
