/**
 * The database refuses a payment that would take an invoice past its total
 * (migration 20261350000000, trigger `invoice_payments_no_over_pay`). The application checks the
 * balance first where it can, but only the database can decide between two payments submitted
 * at the same instant — so every payment writer must be ready for this refusal and say something
 * a person can act on, rather than "try again" (which would be refused again).
 */
type PgError = { code?: string | null; message?: string | null } | null | undefined;

const REFUSAL = /exceeds the ([0-9]+(?:\.[0-9]{1,2})?) still owed on this invoice/;

/** True when `error` is the over-payment guard's refusal. */
export function isOverPaymentRefusal(error: PgError): boolean {
  return !!error && REFUSAL.test(error.message ?? "");
}

/**
 * A message for the operator, or `null` when `error` is something else (callers fall back to
 * their own generic message with `??`).
 */
export function overPaymentMessage(error: PgError): string | null {
  const m = REFUSAL.exec(error?.message ?? "");
  if (!m) return null;
  const owed = Number(m[1]);
  return owed <= 0
    ? "This invoice is already paid in full, so no further payment was recorded. Refresh to see the latest payments."
    : `That is more than the £${owed.toFixed(2)} still owed on this invoice — another payment may have just been recorded. Refresh and record £${owed.toFixed(2)} or less.`;
}
