/**
 * Holiday entitlement — pure, deterministic accrual / balance / carry-over maths.
 *
 * Server- AND client-safe: no Supabase, no Node builtins, no `server-only`. The
 * DB (holiday_entitlements) stores CONFIG ONLY; this module turns that config
 * plus the employee's own `holiday` leave requests into the "days remaining"
 * number surfaced on the leave UI and the staff profile. Kept pure so it is
 * fully unit-tested with no database (see __tests__/staff/holiday.test.ts).
 *
 * Determinism rules that make the maths reproducible:
 *   - Dates are handled as `YYYY-MM-DD` strings in UTC only — no local timezone,
 *     no `Date.now()`. The caller supplies the reference date.
 *   - A holiday is counted in WORKING days (Mon–Fri), inclusive of both ends.
 *     This matches how UK holiday allowances (28 days = 5.6 weeks) are expressed;
 *     weekends inside a booked range do not consume allowance.
 *   - Every derived figure is rounded to 2 decimal places at the boundary so
 *     float noise never leaks into a displayed balance.
 */

export type AccrualMethod = "immediate" | "monthly";

export type HolidayEntitlementConfig = {
  annual_allowance_days: number;
  accrual_method: AccrualMethod;
  carry_over_max_days: number;
  /** Leave-year boundary, month 1-12. */
  leave_year_start_month: number;
  /** Leave-year boundary, day 1-31. */
  leave_year_start_day: number;
};

/** UK statutory minimum: 5.6 weeks = 28 days for a five-day week. */
export const STATUTORY_ANNUAL_ALLOWANCE_DAYS = 28;

export const DEFAULT_HOLIDAY_ENTITLEMENT: HolidayEntitlementConfig = {
  annual_allowance_days: STATUTORY_ANNUAL_ALLOWANCE_DAYS,
  accrual_method: "immediate",
  carry_over_max_days: 0,
  leave_year_start_month: 1,
  leave_year_start_day: 1,
};

/** A leave request reduced to what the balance maths needs. */
export type LeaveSpan = {
  starts_at: string; // YYYY-MM-DD
  ends_at: string; // YYYY-MM-DD
  status: string; // pending | approved | rejected | cancelled
};

export type HolidayBalance = {
  /** Leave-year window containing the reference date (inclusive). */
  leave_year_start: string;
  leave_year_end: string;
  /** The allowance for THIS leave year (pro-rated for a mid-year joiner). */
  allowance_days: number;
  /** Allowance accrued so far under the accrual method, at the reference date. */
  accrued_days: number;
  /** Days brought forward from the previous leave year, after the carry-over cap. */
  carried_over_days: number;
  /** Approved holiday within the current leave year. */
  taken_days: number;
  /** Pending (not-yet-approved) holiday within the current leave year. */
  booked_days: number;
  /** accrued + carried − taken − booked. May be negative if over-booked. */
  remaining_days: number;
};

// ---------------------------------------------------------------------------
// Date helpers (UTC, string-based)
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Parse a `YYYY-MM-DD` string to a UTC Date at midnight. */
function parseIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map((p) => Number(p));
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6; // Sunday | Saturday
}

/**
 * Inclusive count of working days (Mon–Fri) between two ISO dates. Returns 0
 * when the range is empty or reversed. Safe on long ranges (iterates day-by-day
 * with a hard ceiling).
 */
export function workingDaysBetween(startIso: string, endIso: string): number {
  const start = parseIso(startIso);
  const end = parseIso(endIso);
  if (end.getTime() < start.getTime()) return 0;
  let count = 0;
  let cursor = start;
  // Ceiling guards against a malformed multi-decade span.
  for (let i = 0; i <= 366 * 5; i++) {
    if (cursor.getTime() > end.getTime()) break;
    if (!isWeekend(cursor)) count++;
    cursor = addDays(cursor, 1);
  }
  return count;
}

/**
 * The leave-year window (start inclusive, end inclusive) that CONTAINS `refIso`,
 * given a leave-year boundary of month/day. If the reference date is on/after
 * this calendar year's boundary the window starts this year; otherwise it
 * started last year.
 */
export function leaveYearBounds(
  refIso: string,
  startMonth: number,
  startDay: number,
): { start: string; end: string } {
  const ref = parseIso(refIso);
  const year = ref.getUTCFullYear();
  // Clamp the boundary day to the month (e.g. a 31 in a 30-day month).
  const boundaryThisYear = boundaryDate(year, startMonth, startDay);
  const start =
    ref.getTime() >= boundaryThisYear.getTime()
      ? boundaryThisYear
      : boundaryDate(year - 1, startMonth, startDay);
  const nextStart = boundaryDate(start.getUTCFullYear() + 1, startMonth, startDay);
  const end = addDays(nextStart, -1);
  return { start: toIso(start), end: toIso(end) };
}

function boundaryDate(year: number, month: number, day: number): Date {
  // Last day of the target month, to clamp an out-of-range day safely.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1, Math.min(day, lastDay)));
}

/** Whole (completed) months from `aIso` to `bIso`; 0 if b precedes a. */
function wholeMonthsBetween(aIso: string, bIso: string): number {
  const a = parseIso(aIso);
  const b = parseIso(bIso);
  if (b.getTime() < a.getTime()) return 0;
  let months =
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 +
    (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/** The later of two ISO dates. */
function laterIso(a: string, b: string): string {
  return parseIso(a).getTime() >= parseIso(b).getTime() ? a : b;
}

// ---------------------------------------------------------------------------
// Accrual + carry-over
// ---------------------------------------------------------------------------

/**
 * The FULL allowance an employee is entitled to for a given leave year, pro-
 * rated for a mid-year joiner. A joiner who starts N whole months into the
 * leave year earns `allowance × (12 − N) / 12` for that first partial year.
 */
export function entitledDaysForYear(
  config: HolidayEntitlementConfig,
  leaveYearStartIso: string,
  employmentStartIso: string | null,
): number {
  const accrualStart = employmentStartIso
    ? laterIso(leaveYearStartIso, employmentStartIso)
    : leaveYearStartIso;
  const monthsIntoYear = clamp(
    wholeMonthsBetween(leaveYearStartIso, accrualStart),
    0,
    12,
  );
  return round2((config.annual_allowance_days * (12 - monthsIntoYear)) / 12);
}

/**
 * Allowance accrued so far, at `refIso`, within the leave year starting
 * `leaveYearStartIso`.
 *   - 'immediate': the whole (pro-rated) year allowance once the accrual start
 *     has passed, else 0.
 *   - 'monthly': 1/12 of the annual allowance per completed month worked,
 *     capped at the pro-rated year allowance.
 */
export function accruedDays(
  config: HolidayEntitlementConfig,
  refIso: string,
  leaveYearStartIso: string,
  employmentStartIso: string | null,
): number {
  const accrualStart = employmentStartIso
    ? laterIso(leaveYearStartIso, employmentStartIso)
    : leaveYearStartIso;
  const yearAllowance = entitledDaysForYear(
    config,
    leaveYearStartIso,
    employmentStartIso,
  );
  if (parseIso(refIso).getTime() < parseIso(accrualStart).getTime()) return 0;

  if (config.accrual_method === "immediate") {
    return yearAllowance;
  }
  // monthly
  const monthsWorked = wholeMonthsBetween(accrualStart, refIso);
  const accrued = (config.annual_allowance_days * monthsWorked) / 12;
  return round2(Math.min(accrued, yearAllowance));
}

/**
 * Days carried over into the next leave year: the unused portion of the previous
 * year's entitlement, capped by the carry-over maximum. Never negative.
 */
export function computeCarryOver(
  previousEntitledDays: number,
  previousTakenDays: number,
  carryOverMaxDays: number,
): number {
  const unused = previousEntitledDays - previousTakenDays;
  return round2(clamp(unused, 0, Math.max(0, carryOverMaxDays)));
}

// ---------------------------------------------------------------------------
// Leave counting
// ---------------------------------------------------------------------------

/**
 * Working days of the given leave spans (already filtered to the statuses you
 * care about) that fall WITHIN the window, clipping any span that straddles the
 * window boundary.
 */
export function workingDaysInWindow(
  spans: LeaveSpan[],
  windowStartIso: string,
  windowEndIso: string,
  statuses: readonly string[],
): number {
  let total = 0;
  for (const s of spans) {
    if (!statuses.includes(s.status)) continue;
    const clippedStart = laterIso(s.starts_at, windowStartIso);
    const clippedEnd =
      parseIso(s.ends_at).getTime() <= parseIso(windowEndIso).getTime()
        ? s.ends_at
        : windowEndIso;
    if (parseIso(clippedEnd).getTime() < parseIso(clippedStart).getTime()) {
      continue; // span is entirely outside the window
    }
    total += workingDaysBetween(clippedStart, clippedEnd);
  }
  return round2(total);
}

// ---------------------------------------------------------------------------
// The balance
// ---------------------------------------------------------------------------

/**
 * The full holiday balance for one employee at a reference date. `spans` must be
 * the employee's HOLIDAY-type leave requests (the caller filters `type` +
 * org-scopes them). Approved spans count as taken; pending spans count as
 * booked; rejected/cancelled are ignored.
 */
export function computeHolidayBalance(args: {
  config: HolidayEntitlementConfig;
  refIso: string;
  employmentStartIso: string | null;
  spans: LeaveSpan[];
}): HolidayBalance {
  const { config, refIso, employmentStartIso, spans } = args;

  const current = leaveYearBounds(
    refIso,
    config.leave_year_start_month,
    config.leave_year_start_day,
  );
  // The previous leave year ends the day before the current one starts.
  const dayBeforeCurrent = toIso(addDays(parseIso(current.start), -1));
  const previous = leaveYearBounds(
    dayBeforeCurrent,
    config.leave_year_start_month,
    config.leave_year_start_day,
  );

  const allowance = entitledDaysForYear(
    config,
    current.start,
    employmentStartIso,
  );
  const accrued = accruedDays(config, refIso, current.start, employmentStartIso);
  const taken = workingDaysInWindow(spans, current.start, current.end, [
    "approved",
  ]);
  const booked = workingDaysInWindow(spans, current.start, current.end, [
    "pending",
  ]);

  const previousEntitled = entitledDaysForYear(
    config,
    previous.start,
    employmentStartIso,
  );
  const previousTaken = workingDaysInWindow(spans, previous.start, previous.end, [
    "approved",
  ]);
  const carriedOver = computeCarryOver(
    previousEntitled,
    previousTaken,
    config.carry_over_max_days,
  );

  const remaining = round2(accrued + carriedOver - taken - booked);

  return {
    leave_year_start: current.start,
    leave_year_end: current.end,
    allowance_days: allowance,
    accrued_days: accrued,
    carried_over_days: carriedOver,
    taken_days: taken,
    booked_days: booked,
    remaining_days: remaining,
  };
}
