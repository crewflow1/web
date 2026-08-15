/**
 * Multi-day job spans + gantt/resource-lane geometry — PURE, no I/O.
 *
 * A job carries `scheduled_date` and an OPTIONAL `scheduled_end_date`
 * (20261132000003). These helpers turn that pair into a window and lay bars out
 * across a rendered date range for the gantt + resource-swimlane views. Kept
 * pure so the layout is unit-testable without React or Supabase.
 *
 * Deliberately self-contained (its own tiny date maths) so it takes NO
 * dependency on lib/schedule/* — those modules are shared with another engineer
 * and this feature must not couple to them.
 */

const DAY_MS = 86_400_000;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function isDayKey(s: string | null | undefined): s is string {
  return typeof s === "string" && DAY_KEY.test(s);
}

/** Whole days from `from` to `to` (both `YYYY-MM-DD`); NaN on a malformed key. */
export function daysBetween(from: string, to: string): number {
  if (!isDayKey(from) || !isDayKey(to)) return Number.NaN;
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  return Math.round((b - a) / DAY_MS);
}

/** Shift a `YYYY-MM-DD` key by whole days (pure UTC arithmetic). */
export function addDays(dayKey: string, days: number): string {
  if (!isDayKey(dayKey)) return dayKey;
  const d = new Date(`${dayKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface JobSpan {
  /** Inclusive first day. */
  start: string;
  /** Inclusive last day (equal to start for a single-day job). */
  end: string;
  /** Inclusive day count (always >= 1). */
  days: number;
  /** True when an explicit end date extends the job beyond one day. */
  multiDay: boolean;
}

/**
 * Resolve a job's occupied window from its scheduled dates.
 *
 * Returns null for an unscheduled job (no scheduled_date). A null/blank/earlier
 * end date collapses to a single-day span on scheduled_date — the exact
 * behaviour of every job that pre-dates the span column.
 */
export function resolveJobSpan(
  scheduledDate: string | null | undefined,
  scheduledEndDate: string | null | undefined,
): JobSpan | null {
  if (!isDayKey(scheduledDate)) return null;
  const start = scheduledDate;
  let end = start;
  if (isDayKey(scheduledEndDate)) {
    const delta = daysBetween(start, scheduledEndDate);
    if (Number.isFinite(delta) && delta > 0) end = scheduledEndDate;
  }
  const days = daysBetween(start, end) + 1;
  return { start, end, days, multiDay: end !== start };
}

export interface GanttWindow {
  /** Inclusive first day rendered. */
  from: string;
  /** Inclusive last day rendered. */
  to: string;
  /** Inclusive day count of the window. */
  totalDays: number;
}

/** Build a rendered window from an inclusive [from, to] date pair. */
export function buildGanttWindow(from: string, to: string): GanttWindow {
  const totalDays = Math.max(1, daysBetween(from, to) + 1);
  return { from, to, totalDays };
}

export interface GanttBar<T> {
  item: T;
  span: JobSpan;
  /** Day index of the bar's visible start, from the window's `from` (>= 0). */
  offsetDays: number;
  /** Visible width in days within the window (>= 1). */
  spanDays: number;
  /** The bar starts before the window (clipped on the left). */
  clippedStart: boolean;
  /** The bar ends after the window (clipped on the right). */
  clippedEnd: boolean;
  /** offsetDays / totalDays as a 0..1 fraction (for CSS %). */
  offsetFraction: number;
  /** spanDays / totalDays as a 0..1 fraction. */
  widthFraction: number;
}

/**
 * Lay one job's span out inside a window. Returns null when the span does not
 * intersect the window at all (so the caller drops it).
 */
export function layoutBar<T>(
  item: T,
  span: JobSpan,
  window: GanttWindow,
): GanttBar<T> | null {
  const startIdx = daysBetween(window.from, span.start);
  const endIdx = daysBetween(window.from, span.end);
  if (!Number.isFinite(startIdx) || !Number.isFinite(endIdx)) return null;
  // No intersection with [0, totalDays-1].
  if (endIdx < 0 || startIdx > window.totalDays - 1) return null;

  const visibleStart = Math.max(0, startIdx);
  const visibleEnd = Math.min(window.totalDays - 1, endIdx);
  const spanDays = visibleEnd - visibleStart + 1;

  return {
    item,
    span,
    offsetDays: visibleStart,
    spanDays,
    clippedStart: startIdx < 0,
    clippedEnd: endIdx > window.totalDays - 1,
    offsetFraction: visibleStart / window.totalDays,
    widthFraction: spanDays / window.totalDays,
  };
}

/**
 * Lay a set of dated items out as gantt bars within a window, dropping any that
 * fall entirely outside it. Deterministic: bars are ordered by visible start,
 * then span start, then a caller-supplied stable key.
 */
export function layoutGantt<T>(
  items: T[],
  window: GanttWindow,
  getSpan: (item: T) => JobSpan | null,
  getKey: (item: T) => string,
): GanttBar<T>[] {
  const bars: GanttBar<T>[] = [];
  for (const item of items) {
    const span = getSpan(item);
    if (!span) continue;
    const bar = layoutBar(item, span, window);
    if (bar) bars.push(bar);
  }
  return bars.sort((a, b) => {
    if (a.offsetDays !== b.offsetDays) return a.offsetDays - b.offsetDays;
    if (a.span.start !== b.span.start) return a.span.start < b.span.start ? -1 : 1;
    const ka = getKey(a.item);
    const kb = getKey(b.item);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export interface ResourceLane<T> {
  /** Stable lane key: a staff id, or "" for the unassigned lane. */
  key: string;
  label: string;
  bars: GanttBar<T>[];
}

/**
 * Group gantt bars into resource swimlanes by assignee.
 *
 * `staff` fixes the lane order (so lanes are stable and every staff member gets
 * a lane even with no work); an "Unassigned" lane is appended only when at least
 * one bar has no assignee. Bars whose assignee is not in `staff` (e.g. a
 * since-removed member) fall into the unassigned lane rather than vanishing.
 */
export function groupResourceLanes<T>(
  bars: GanttBar<T>[],
  staff: { id: string; name: string }[],
  getAssignee: (item: T) => string | null,
): ResourceLane<T>[] {
  const staffIds = new Set(staff.map((s) => s.id));
  const byLane = new Map<string, GanttBar<T>[]>();
  for (const s of staff) byLane.set(s.id, []);
  const unassigned: GanttBar<T>[] = [];

  for (const bar of bars) {
    const who = getAssignee(bar.item);
    if (who && staffIds.has(who)) byLane.get(who)!.push(bar);
    else unassigned.push(bar);
  }

  const lanes: ResourceLane<T>[] = staff.map((s) => ({
    key: s.id,
    label: s.name,
    bars: byLane.get(s.id)!,
  }));
  if (unassigned.length > 0) {
    lanes.push({ key: "", label: "Unassigned", bars: unassigned });
  }
  return lanes;
}
