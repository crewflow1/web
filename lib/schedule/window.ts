import { formatDayKeyUK, UK_TIME_ZONE } from "@/lib/time/format";

/**
 * Schedule Integrity — interval + Europe/London day maths (PURE, no I/O).
 *
 * Two things every conflict rule needs, and both are easy to get subtly wrong:
 *
 *   1. INTERVAL OVERLAP with an explicit boundary rule.
 *   2. The UTC INSTANT at which a UK calendar day begins — CrewFlow stores
 *      `timestamptz` for shifts but `date` for leave and job scheduling, so
 *      comparing the two means turning a UK date into a real instant. Doing
 *      that with `new Date("2026-07-20T00:00:00Z")` is wrong for seven months
 *      of the year: in BST the UK day 20 July actually starts at 23:00Z on
 *      the 19th, so a 23:30Z shift would be filed under the wrong day and a
 *      genuine leave clash would be missed (or invented).
 *
 * `formatDayKeyUK` (lib/time/format.ts) is the established day-bucket idiom
 * and is reused verbatim for the instant → day direction; this module supplies
 * the inverse, which the codebase did not have.
 */

// ── Interval overlap ─────────────────────────────────────────────────────────

/**
 * A half-open instant range `[start, end)` in epoch milliseconds.
 *
 * HALF-OPEN IS THE PRODUCT'S DECISION, NOT A CONVENIENCE. Touching endpoints
 * do NOT overlap: a shift ending 12:00 and another starting 12:00 is a handover,
 * not a double-booking. This is the identical rule the rota's own write-time
 * guard already applies — `app/(app)/staff/actions.ts` refuses a new shift when
 * `newStart < existingEnd && existingStart < newEnd` — so the read-side detector
 * and the write-side guard can never disagree about what "clash" means.
 *
 * A zero-length interval (`start === end`) therefore overlaps NOTHING, including
 * itself. That is the correct answer for an instantaneous plant transfer (custody
 * closed and reopened at the same instant is a handover, not two custodians), and
 * `rota_entries` cannot produce one at all — the table CHECKs `ends_at > starts_at`.
 */
export interface Interval {
  start: number;
  end: number;
}

/**
 * True when two half-open intervals share at least one instant.
 *
 * The emptiness guard is not decoration: the classic
 * `a.start < b.end && b.start < a.end` test reports a ZERO-LENGTH interval
 * sitting inside another as overlapping, which contradicts `[t, t)` being the
 * empty set — and would have made `overlaps` and `intersection` disagree.
 */
export function overlaps(a: Interval, b: Interval): boolean {
  if (a.start >= a.end || b.start >= b.end) return false;
  return a.start < b.end && b.start < a.end;
}

/** The shared portion of two intervals, or null when they merely touch/miss. */
export function intersection(a: Interval, b: Interval): Interval | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return start < end ? { start, end } : null;
}

// ── Europe/London calendar days ──────────────────────────────────────────────

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Formats an instant as Europe/London wall-clock fields. `hourCycle: "h23"` is
 * pinned because en-GB's default (h12/h24) renders midnight as hour "24", which
 * would silently shift the offset calculation by a day.
 */
const UK_FIELDS = new Intl.DateTimeFormat("en-GB", {
  timeZone: UK_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/**
 * The UK's UTC offset, in ms, AT a given instant (0 in GMT, +3_600_000 in BST).
 * Derived from the IANA database via Intl rather than from hard-coded transition
 * dates, so it stays correct when the transition rules change.
 */
function ukOffsetAt(utcMs: number): number {
  const parts = UK_FIELDS.formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  // Rounded to the second because `asIfUtc` carries no sub-second precision.
  return asIfUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * The UTC instant at which the Europe/London calendar day `YYYY-MM-DD` begins.
 *
 * Two-pass fixed point: guess the offset from the naive UTC midnight, apply it,
 * then re-read the offset at the corrected instant. One correction is provably
 * enough for a ±1h transition — the second read lands on the true local midnight,
 * whose offset is the one that defines the day's start. Verified against both
 * real 2026 transitions (29 March 01:00Z → BST, 25 October 01:00Z → GMT).
 *
 * Returns NaN for a malformed key; callers treat that as "no usable date" and
 * drop the row rather than sorting it to an arbitrary position.
 */
export function ukDayStartMs(dayKey: string): number {
  const m = DAY_KEY.exec(dayKey.trim());
  if (!m) return Number.NaN;
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(naive)) return Number.NaN;
  const guess = naive - ukOffsetAt(naive);
  return naive - ukOffsetAt(guess);
}

/**
 * The exclusive end of a UK calendar day — i.e. the start of the next one.
 * On 25 October 2026 this day is 25 hours long, and on 29 March it is 23; both
 * fall out of the offset lookup rather than being special-cased.
 */
export function ukDayEndMs(dayKey: string): number {
  return ukDayStartMs(addDays(dayKey, 1));
}

/** The half-open instant range covered by a UK calendar day. */
export function ukDayInterval(dayKey: string): Interval {
  return { start: ukDayStartMs(dayKey), end: ukDayEndMs(dayKey) };
}

/**
 * Shift a `YYYY-MM-DD` key by whole calendar days. Pure string/UTC arithmetic —
 * day KEYS are timezone-free labels, so no offset is involved here; only turning
 * a key into an instant needs the zone.
 */
export function addDays(dayKey: string, days: number): string {
  const m = DAY_KEY.exec(dayKey.trim());
  if (!m) return dayKey;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  // Both endpoints are naive UTC midnights of a KEY, so this is exact whole days
  // regardless of any DST transition between them.
  return Math.round((b - a) / 86_400_000);
}

/** The Europe/London calendar day an instant falls on. Re-exported idiom. */
export function ukDayKeyOf(instant: Date | string | number): string {
  return formatDayKeyUK(instant);
}

// ── The detection window ─────────────────────────────────────────────────────

/**
 * How far ahead conflict detection looks, in UK days INCLUSIVE of today.
 *
 * A fortnight is the horizon an owner can actually act on: rota is planned one
 * to three weeks out, and a clash 40 days away will still be flagged — just on
 * the day the rolling window reaches it, not today. Bounding it is also what
 * keeps the reads cheap: `rota_entries (org_id, starts_at)` and
 * `jobs (org_id, scheduled_date)` both index the exact range this produces, so
 * a busy org scans a fortnight, never a year.
 */
export const SCHEDULE_WINDOW_DAYS = 14;

/**
 * Lookback pad applied to the `starts_at` LOWER bound when reading rota entries.
 *
 * A shift that began before the window but runs INTO it is a real participant in
 * a clash, yet `ends_at` is not indexed — filtering on it would turn the read
 * into a full-history scan for the org. Padding the indexed `starts_at` bound by
 * 48 hours keeps the index range scan and catches every shift of a plausible
 * length. A single rota entry longer than 48 hours is not a shift, and its
 * pre-window portion is not represented; that is a deliberate, stated limit.
 */
export const ROTA_LOOKBACK_MS = 2 * 86_400_000;

export interface ScheduleWindow {
  /** UK day the window opens on (today, in Europe/London). */
  fromDay: string;
  /** Last UK day INSIDE the window (inclusive). */
  toDay: string;
  /** Instant range `[start of fromDay, end of toDay)`. */
  interval: Interval;
  /** The instant the caller's clock read — pinned so output is reproducible. */
  nowMs: number;
}

/**
 * Build the detection window from a clock. Deliberately forward-looking: a
 * double-booking that has already happened cannot be fixed, so the window opens
 * at the START of today's UK day (not at `now`) — that keeps a shift already in
 * progress this morning in scope — and runs to the end of day +13.
 */
export function buildScheduleWindow(now: Date, days: number = SCHEDULE_WINDOW_DAYS): ScheduleWindow {
  const fromDay = formatDayKeyUK(now);
  const toDay = addDays(fromDay, Math.max(1, days) - 1);
  return {
    fromDay,
    toDay,
    interval: { start: ukDayStartMs(fromDay), end: ukDayEndMs(toDay) },
    nowMs: now.getTime(),
  };
}
