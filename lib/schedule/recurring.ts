/**
 * Recurring-job expansion.
 *
 * Given a parent job with `recurring = { pattern, end_date? }` and an
 * anchor `scheduled_date`, produce the list of occurrence dates that
 * fall inside a [from, to] window.
 *
 * Patterns:
 *   - weekly    +7 days
 *   - biweekly  +14 days
 *   - monthly   +1 calendar month (uses Date math; last-day-of-month
 *               corner case OK for v1 — Date rolls forward)
 *   - quarterly +3 calendar months
 *
 * Caps:
 *   - end_date  honoured (inclusive) if set
 *   - hard cap of 60 occurrences per parent within the window so a
 *     misconfigured parent can't blow up the calendar
 */

export type RecurringPattern = {
  pattern: "weekly" | "biweekly" | "monthly" | "quarterly";
  end_date?: string;
};

const MAX_OCCURRENCES = 60;

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

function addMonths(d: Date, months: number): Date {
  const out = new Date(d);
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function expandRecurring(
  parentDate: string,
  recurring: RecurringPattern,
  rangeFromIso: string,
  rangeToIso: string,
): string[] {
  if (!parentDate) return [];
  const start = new Date(`${parentDate}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return [];
  const rangeFrom = new Date(`${rangeFromIso}T00:00:00Z`);
  const rangeTo = new Date(`${rangeToIso}T00:00:00Z`);
  const stop =
    recurring.end_date && /^\d{4}-\d{2}-\d{2}$/.test(recurring.end_date)
      ? new Date(`${recurring.end_date}T00:00:00Z`)
      : null;

  const out: string[] = [];
  let cursor = new Date(start);

  for (let i = 0; i < MAX_OCCURRENCES; i++) {
    if (stop && cursor > stop) break;
    if (cursor > rangeTo) break;
    if (cursor >= rangeFrom) out.push(isoDate(cursor));

    switch (recurring.pattern) {
      case "weekly":
        cursor = addDays(cursor, 7);
        break;
      case "biweekly":
        cursor = addDays(cursor, 14);
        break;
      case "monthly":
        cursor = addMonths(cursor, 1);
        break;
      case "quarterly":
        cursor = addMonths(cursor, 3);
        break;
    }
  }
  return out;
}

export function isValidRecurringPayload(value: unknown): value is RecurringPattern {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (
    v.pattern !== "weekly" &&
    v.pattern !== "biweekly" &&
    v.pattern !== "monthly" &&
    v.pattern !== "quarterly"
  ) {
    return false;
  }
  if (
    v.end_date !== undefined &&
    v.end_date !== null &&
    !(typeof v.end_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.end_date))
  ) {
    return false;
  }
  return true;
}
