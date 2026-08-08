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
 *   - hard cap of 60 occurrences per parent WITHIN THE WINDOW so a
 *     misconfigured parent can't blow up the calendar
 *
 * Window-relative cap:
 *   The cap counts occurrences produced *inside* [rangeFrom, rangeTo], not
 *   steps taken from the anchor. Before the counted loop we fast-forward the
 *   cursor from the anchor to the first occurrence >= rangeFrom without
 *   spending the budget, so a parent anchored arbitrarily far in the past
 *   (e.g. an open-ended weekly job anchored 2 years ago) still expands into
 *   the current window instead of silently vanishing.
 */

export type RecurringPattern = {
  pattern: "weekly" | "biweekly" | "monthly" | "quarterly";
  end_date?: string;
};

export const MAX_OCCURRENCES = 60;

const MS_PER_DAY = 86_400_000;

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

  // ---- Window-relative fast-forward -------------------------------------
  // Advance the cursor from the anchor to the first occurrence >= rangeFrom
  // WITHOUT spending the MAX_OCCURRENCES budget. The fast-forward must land on
  // exactly the same dates the naive per-step loop below would have produced —
  // it only skips the pre-window occurrences, it must never shift them.
  if (cursor < rangeFrom) {
    switch (recurring.pattern) {
      case "weekly":
      case "biweekly": {
        // Day-based intervals are path-independent under UTC day arithmetic:
        // start + k*stepDays is the k-th occurrence regardless of how we get
        // there. Jump arithmetically to the first k with cursor >= rangeFrom,
        // then land the cursor via the module's own addDays so the result is
        // byte-identical to the loop (and DST-safe, since all math is UTC).
        const stepDays = recurring.pattern === "weekly" ? 7 : 14;
        const deltaMs = rangeFrom.getTime() - start.getTime();
        const steps = Math.max(0, Math.ceil(deltaMs / (stepDays * MS_PER_DAY)));
        cursor = addDays(start, steps * stepDays);
        break;
      }
      case "monthly":
      case "quarterly": {
        // Month steps are PATH-DEPENDENT because of day-of-month rollover:
        // addMonths(Jan31,1)=Mar3 then +1=Apr3, but addMonths(Jan31,2)=Mar31.
        // A single addMonths(start, n) jump would therefore NOT match the
        // loop. Reuse the module's own addMonths one period at a time — this
        // reproduces the loop's exact sequence, just uncounted — while still
        // honouring stop/rangeTo so we never walk past the end of interest.
        const stepMonths = recurring.pattern === "monthly" ? 1 : 3;
        while (cursor < rangeFrom) {
          if (stop && cursor > stop) break;
          if (cursor > rangeTo) break;
          cursor = addMonths(cursor, stepMonths);
        }
        break;
      }
    }
  }

  // ---- Counted emit loop (anti-blowup cap, now window-relative) ----------
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
