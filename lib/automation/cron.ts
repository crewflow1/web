/**
 * Automation OS — deterministic cron evaluation.
 *
 * Pure, importable everywhere (server + client): no clock of its own, no I/O.
 * The caller passes `from`, so `computeNextRun` is a pure function of
 * (expression, from) and two callers on two machines always agree — exactly
 * what the schedule drain's optimistic claim relies on to advance `next_run_at`
 * without a race.
 *
 * SCOPE — standard 5-field cron, interpreted in UTC:
 *
 *     ┌───────── minute        (0-59)
 *     │ ┌─────── hour          (0-23)
 *     │ │ ┌───── day-of-month  (1-31)
 *     │ │ │ ┌─── month         (1-12)
 *     │ │ │ │ ┌─ day-of-week   (0-6, Sunday = 0; 7 also accepted for Sunday)
 *     │ │ │ │ │
 *     * * * * *
 *
 * Each field supports `*`, a single value, a `a-b` range, a `*(/)n` step
 * (`* / n` or `a-b / n`), and comma-separated lists of the above.
 *
 * WHY UTC, NOT Europe/London. A schedule fires on a clock, and a
 * timezone-anchored clock is ambiguous twice a year (the BST↔GMT transitions:
 * one local time never happens, another happens twice). UTC has no such
 * discontinuity, so "advance to the next occurrence" is always a single,
 * total-ordered answer. The product surface can present the next-run instant in
 * London time; the ARITHMETIC stays in UTC on purpose.
 *
 * DAY-OF-MONTH vs DAY-OF-WEEK follow the POSIX rule: when BOTH are restricted
 * (neither is `*`), a day matches if EITHER matches (union); when only one is
 * restricted, only that one constrains. This is what `0 9 * * 1` (09:00 every
 * Monday) and `0 9 1 * *` (09:00 on the 1st) both mean intuitively, and what a
 * combined `0 9 13 * 5` (the 13th OR any Friday) means by convention.
 */

const FIELD_BOUNDS = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // day-of-month
  { min: 1, max: 12 }, // month
  { min: 0, max: 7 }, //  day-of-week (0 and 7 both Sunday)
] as const;

export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronParseError";
  }
}

type ParsedField = {
  /** The set of legal values for this field, already normalised. */
  values: ReadonlySet<number>;
  /** True when the field was `*` — needed for the dom/dow union rule. */
  wildcard: boolean;
};

type ParsedCron = {
  minute: ParsedField;
  hour: ParsedField;
  dom: ParsedField;
  month: ParsedField;
  dow: ParsedField;
};

function parseField(raw: string, index: number): ParsedField {
  const { min, max } = FIELD_BOUNDS[index]!;
  const token = raw.trim();
  if (token.length === 0) {
    throw new CronParseError(`cron field ${index + 1} is empty`);
  }

  // Only a literal "*" disables the field for the POSIX day-of-month/day-of-week
  // union rule. A stepped "*/n" IS a restricted field (its value set is a strict
  // subset), so it must NOT count as a wildcard — otherwise dayMatches() ignores
  // the value set and fires every day instead of every nth day.
  const wildcard = token === "*";
  const values = new Set<number>();

  for (const part of token.split(",")) {
    const piece = part.trim();
    if (piece.length === 0) {
      throw new CronParseError(`cron field ${index + 1} has an empty list item`);
    }

    // Split off an optional step: "<range>/<step>".
    const [rangePart, stepPart, ...rest] = piece.split("/");
    if (rest.length > 0) {
      throw new CronParseError(`cron field ${index + 1}: malformed step in "${piece}"`);
    }
    let step = 1;
    if (stepPart !== undefined) {
      step = Number(stepPart);
      if (!Number.isInteger(step) || step <= 0) {
        throw new CronParseError(`cron field ${index + 1}: step must be a positive integer`);
      }
    }

    let lo: number;
    let hi: number;
    const rp = (rangePart ?? "").trim();
    if (rp === "*" || rp === "") {
      lo = min;
      hi = max;
    } else if (rp.includes("-")) {
      const [a, b, ...more] = rp.split("-");
      if (more.length > 0) {
        throw new CronParseError(`cron field ${index + 1}: malformed range "${rp}"`);
      }
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rp);
      hi = lo;
    }

    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new CronParseError(`cron field ${index + 1}: non-integer value in "${piece}"`);
    }
    if (lo < min || hi > max || lo > hi) {
      throw new CronParseError(
        `cron field ${index + 1}: value out of range in "${piece}" (allowed ${min}-${max})`,
      );
    }

    for (let v = lo; v <= hi; v += step) values.add(v);
  }

  // Day-of-week: normalise 7 → 0 so Sunday has one representation.
  if (index === 4 && values.has(7)) {
    values.delete(7);
    values.add(0);
  }

  if (values.size === 0) {
    throw new CronParseError(`cron field ${index + 1}: matched no values`);
  }
  return { values, wildcard };
}

/** Parse + validate a 5-field cron expression. Throws CronParseError. */
export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(
      `cron expression must have exactly 5 fields, got ${fields.length}`,
    );
  }
  return {
    minute: parseField(fields[0]!, 0),
    hour: parseField(fields[1]!, 1),
    dom: parseField(fields[2]!, 2),
    month: parseField(fields[3]!, 3),
    dow: parseField(fields[4]!, 4),
  };
}

/** True when `expr` is a valid 5-field cron expression. */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

function dayMatches(parsed: ParsedCron, date: Date): boolean {
  const domRestricted = !parsed.dom.wildcard;
  const dowRestricted = !parsed.dow.wildcard;
  const domHit = parsed.dom.values.has(date.getUTCDate());
  const dowHit = parsed.dow.values.has(date.getUTCDay());
  // POSIX union rule (see file header).
  if (domRestricted && dowRestricted) return domHit || dowHit;
  if (domRestricted) return domHit;
  if (dowRestricted) return dowHit;
  return true;
}

/**
 * The next UTC instant strictly AFTER `from` that matches `expr`.
 *
 * Deterministic and total: given the same (expr, from) it always returns the
 * same instant. Advances field-by-field (skip to the next valid month, then
 * day, then hour, then minute) rather than ticking one minute at a time, so the
 * worst case is bounded and cheap even for sparse schedules like `0 0 29 2 *`.
 *
 * Throws CronParseError for a malformed expression, and a plain Error if no
 * occurrence exists within a defensive horizon (e.g. an impossible date). The
 * horizon is generous enough that every real cron resolves long before it.
 */
export function computeNextRun(expr: string, from: Date): Date {
  const parsed = parseCron(expr);

  // Start at the next whole minute strictly after `from` — cron has minute
  // resolution and "strictly after" prevents re-firing the instant we came from.
  const cur = new Date(from.getTime());
  cur.setUTCSeconds(0, 0);
  cur.setUTCMinutes(cur.getUTCMinutes() + 1);

  // Defensive horizon: 5 years of minutes. A leap-day-only schedule is the
  // sparsest real case and resolves within ~4 years; beyond this the expression
  // is effectively unsatisfiable and we say so rather than spin.
  const HORIZON_MS = 5 * 366 * 24 * 60 * 60 * 1000;
  const deadline = from.getTime() + HORIZON_MS;

  while (cur.getTime() <= deadline) {
    if (!parsed.month.values.has(cur.getUTCMonth() + 1)) {
      // Jump to the first day of the next month at 00:00.
      cur.setUTCMonth(cur.getUTCMonth() + 1, 1);
      cur.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(parsed, cur)) {
      // Jump to 00:00 of the next day.
      cur.setUTCDate(cur.getUTCDate() + 1);
      cur.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!parsed.hour.values.has(cur.getUTCHours())) {
      // Jump to the next hour at :00.
      cur.setUTCHours(cur.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!parsed.minute.values.has(cur.getUTCMinutes())) {
      cur.setUTCMinutes(cur.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return new Date(cur.getTime());
  }

  throw new Error(
    `cron expression "${expr}" has no occurrence within the 5-year horizon`,
  );
}
