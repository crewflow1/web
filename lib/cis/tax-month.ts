/**
 * CIS tax months — the ONE definition, because M4's monthly return is built on it.
 *
 * PURE. No Supabase, no server-only, no I/O.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * HMRC CIS340 §§3.15 and 4.2: "A tax month runs from the sixth of one month to
 * the fifth of the next month." Verified 27 July 2026 — see docs/cis-domain.md §4.
 *
 * These are NOT calendar months, and treating them as such files payments in the
 * wrong return. A payment on 3 June belongs to 6 May – 5 June; one on 7 June
 * belongs to 6 June – 5 July. The boundary is the single easiest thing in this
 * domain to get quietly wrong, so it lives in exactly one place with a matching
 * SQL twin (`public.cis_tax_month_start` / `_end`, 20261051000000) that the
 * database uses when it freezes a payment's tax month into its snapshot.
 *
 * ── WHY UTC ─────────────────────────────────────────────────────────────────
 * Every date here is a plain `yyyy-mm-dd` calendar date, and all arithmetic goes
 * through `Date.UTC`. Using local time would put a UK user in BST one hour ahead
 * of UTC, so `new Date("2026-06-06")` (parsed as midnight UTC) rendered locally
 * is still 6 June — but any construction that goes the other way can slip a
 * payment made on the 6th back into the previous tax month. UTC throughout
 * removes the class of bug rather than patching instances of it.
 */

/** The day of the month a CIS tax month starts on. HMRC CIS340 3.15/4.2. */
export const CIS_TAX_MONTH_START_DAY = 6;

/** Monthly CIS return deadline: the 19th of the month after the tax month ends. */
export const CIS_RETURN_DUE_DAY = 19;

/**
 * Deadline for paying deductions over to HMRC: the 22nd electronically, or the
 * 19th by post. GOV.UK, "Pay deductions to HMRC": "Pay HMRC every month by the
 * 22nd (or the 19th if you're paying by post)."
 */
export const CIS_PAYMENT_DUE_DAY_ELECTRONIC = 22;
export const CIS_PAYMENT_DUE_DAY_POSTAL = 19;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toUtcParts(iso: string): { y: number; m: number; d: number } | null {
  if (!ISO_DATE.test(iso)) return null;
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  if (!Number.isFinite(y) || m < 1 || m > 12 || d < 1 || d > 31) return null;
  // Reject impossible calendar dates (31 February) rather than letting Date roll
  // them over into the next month, which would silently move a tax month.
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return { y, m, d };
}

function fmt(date: Date): string {
  const y = String(date.getUTCFullYear()).padStart(4, "0");
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * First day (the 6th) of the CIS tax month containing `iso`.
 * Returns null for anything that is not a real `yyyy-mm-dd` date.
 */
export function cisTaxMonthStart(iso: string): string | null {
  const p = toUtcParts(iso);
  if (!p) return null;
  // On or after the 6th → this month's 6th. Before → the previous month's 6th.
  // Date.UTC normalises month -1 across a year boundary on its own.
  const monthOffset = p.d >= CIS_TAX_MONTH_START_DAY ? 0 : -1;
  return fmt(new Date(Date.UTC(p.y, p.m - 1 + monthOffset, CIS_TAX_MONTH_START_DAY)));
}

/** Last day (the 5th) of the CIS tax month containing `iso`. */
export function cisTaxMonthEnd(iso: string): string | null {
  const start = cisTaxMonthStart(iso);
  if (!start) return null;
  const p = toUtcParts(start);
  if (!p) return null;
  return fmt(new Date(Date.UTC(p.y, p.m, CIS_TAX_MONTH_START_DAY - 1)));
}

/** `{ start, end }` for the CIS tax month containing `iso`, or null. */
export function cisTaxMonth(iso: string): { start: string; end: string } | null {
  const start = cisTaxMonthStart(iso);
  const end = cisTaxMonthEnd(iso);
  return start && end ? { start, end } : null;
}

/**
 * Deadline for the monthly CIS return covering the tax month containing `iso`:
 * the 19th of the month FOLLOWING the tax month's end.
 *
 * The tax month ending 5 June is returned by 19 June — the end date's own month,
 * because the month runs 6 May → 5 June. Deriving it from the END date rather
 * than the start is what makes that come out right.
 */
export function cisReturnDueDate(iso: string): string | null {
  const end = cisTaxMonthEnd(iso);
  if (!end) return null;
  const p = toUtcParts(end);
  if (!p) return null;
  return fmt(new Date(Date.UTC(p.y, p.m - 1, CIS_RETURN_DUE_DAY)));
}

/** Deadline for paying the deductions over to HMRC. */
export function cisPaymentDueDate(iso: string, postal = false): string | null {
  const end = cisTaxMonthEnd(iso);
  if (!end) return null;
  const p = toUtcParts(end);
  if (!p) return null;
  const day = postal ? CIS_PAYMENT_DUE_DAY_POSTAL : CIS_PAYMENT_DUE_DAY_ELECTRONIC;
  return fmt(new Date(Date.UTC(p.y, p.m - 1, day)));
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

function human(iso: string): string {
  const p = toUtcParts(iso);
  if (!p) return iso;
  return `${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}

/**
 * Operator-facing label, e.g. "6 May 2026 to 5 June 2026". Spelled out in full
 * rather than as "May 2026" precisely because a CIS month is not a calendar
 * month, and a label that looks like one invites the reader to assume it is.
 */
export function cisTaxMonthLabel(iso: string): string | null {
  const m = cisTaxMonth(iso);
  return m ? `${human(m.start)} to ${human(m.end)}` : null;
}

/** True when two dates fall in the same CIS tax month. */
export function isSameCisTaxMonth(a: string, b: string): boolean {
  const sa = cisTaxMonthStart(a);
  const sb = cisTaxMonthStart(b);
  return sa !== null && sa === sb;
}
