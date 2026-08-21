import { formatDayKeyUK } from "@/lib/time/format";
import { addDays, ukDayEndMs, ukDayStartMs } from "@/lib/schedule/window";
import type { DayWindow } from "./provenance";

/**
 * Trailing Europe/London windows for the intelligence layer. PURE.
 *
 * NO `toISOString()` DAY MATHS ANYWHERE. A UTC day key and a London day key
 * disagree for an hour a night in winter and for 23:00 to 00:00 every summer
 * night, and the repo has just had a BST month-end incident. Day keys come
 * from `formatDayKeyUK` (the established instant → London-day idiom) and the
 * instants bounding a day come from `ukDayStartMs`/`ukDayEndMs`
 * (lib/schedule/window's fixed-point offset lookup, verified against both
 * real 2026 transitions). This module composes those; it defines no zone
 * arithmetic of its own.
 */

export interface InstantDayWindow extends DayWindow {
  /** UTC ms at which `fromDay` begins in London. */
  startMs: number;
  /** UTC ms at which the day AFTER `toDay` begins in London (exclusive end). */
  endMs: number;
}

/**
 * The trailing window of `days` London calendar days ENDING TODAY (inclusive).
 * `days = 30` means today plus the 29 days before it.
 */
export function trailingDayWindow(now: Date, days: number): InstantDayWindow {
  const toDay = formatDayKeyUK(now);
  const fromDay = addDays(toDay, -(Math.max(1, days) - 1));
  return {
    fromDay,
    toDay,
    startMs: ukDayStartMs(fromDay),
    endMs: ukDayEndMs(toDay),
  };
}

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * The same calendar date `months` months earlier, CLAMPED to the shorter
 * month's last day (2028-03-31 − 1 month → 2028-02-29; −12 → 2027-03-31).
 *
 * Pure key arithmetic in UTC field space — a day KEY is a timezone-free
 * label, so no offset is involved (the lib/schedule/window rule); only
 * turning a key into an instant needs the zone, and callers do that via
 * `ukDayStartMs`.
 */
export function monthsBeforeDayKey(dayKey: string, months: number): string {
  const m = DAY_KEY.exec(dayKey.trim());
  if (!m) return dayKey;
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-based
  const day = Number(m[3]);
  const targetIndex = year * 12 + (month - 1) - months;
  const targetYear = Math.floor(targetIndex / 12);
  const targetMonth = targetIndex - targetYear * 12; // 0-based
  // Days in the target month, via the day-0-of-next-month trick (UTC fields).
  const daysInTarget = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const clamped = Math.min(day, daysInTarget);
  const d = new Date(Date.UTC(targetYear, targetMonth, clamped));
  return d.toISOString().slice(0, 10);
}

/**
 * The trailing 12-month window ending today: from the same London date a year
 * ago (clamped) through today, inclusive.
 */
export function trailingMonthsWindow(now: Date, months: number): InstantDayWindow {
  const toDay = formatDayKeyUK(now);
  const fromDay = monthsBeforeDayKey(toDay, months);
  return {
    fromDay,
    toDay,
    startMs: ukDayStartMs(fromDay),
    endMs: ukDayEndMs(toDay),
  };
}
