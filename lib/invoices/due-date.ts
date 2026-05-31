/**
 * Default payment terms for auto-generated invoices.
 *
 * Server/client-safe — pure date math, no imports.
 *
 * When a quote is accepted (owner- or public-portal), the invoice is created
 * as a `draft` with no externally-supplied due date. We apply net-14 so the
 * customer always sees a concrete payment deadline instead of a blank field.
 *
 * Note: Stripe-driven invoices keep whatever due date Stripe supplies; this
 * default only applies to the in-app quote → invoice path.
 */
export const INVOICE_DUE_DAYS = 14;

/**
 * Returns the invoice due date (`YYYY-MM-DD`) `days` after `fromIso`.
 *
 * `invoices.due_date` is a Postgres `date` column, so we return a calendar
 * date string with no time component. The arithmetic runs in UTC to stay
 * deterministic regardless of the server's timezone.
 *
 * Defensive: if `fromIso` can't be parsed, falls back to "now" so we never
 * emit an invalid date into the column.
 */
export function invoiceDueDate(
  fromIso: string,
  days: number = INVOICE_DUE_DAYS,
): string {
  const parsed = new Date(fromIso);
  const base = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}
