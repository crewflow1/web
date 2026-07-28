/**
 * Translate a Postgres error from a finances write into a message a site manager
 * can act on — never a raw SQL string, which can echo row contents.
 *
 * Keep this server/client-safe: no server-only imports here.
 */

/** HTTP status + body for a refused finances write. */
export type FinanceWriteRefusal = { status: number; error: string };

/**
 * `tg_finances_bill_value_guard` (20261054000000) raises check_violation (23514)
 * for the two reasons a bill's value or VAT rate may not move. Both are a
 * conflict with the resource's current state rather than a malformed request or
 * a server fault, so both are a 409 — and each has to name ITS OWN way out,
 * because they are different:
 *
 *   1. CIS BASIS FREEZE — the bill is part-paid under CIS, a deduction has been
 *      reported from it, and the only exit is void, correct, re-post.
 *   2. SETTLEMENT FLOOR — an ordinary bill is being cut below what has already
 *      been paid against it. Voiding works, but so does simply not cutting it so
 *      far, which is usually what the user meant. Sending someone through the
 *      CIS ceremony for this would be telling them the wrong thing.
 *
 * Returns null when the error is not one we recognise, so the caller keeps its
 * existing generic handling.
 */
export function financeWriteRefusal(
  code: string | undefined,
  message: string | undefined,
): FinanceWriteRefusal | null {
  const isCheck = code === "23514" || code === "check_violation";
  if (isCheck && message && /part-paid under CIS/i.test(message)) {
    return {
      status: 409,
      error:
        "This bill has already been part-paid under CIS, so its value and VAT rate are locked — " +
        "a deduction has been calculated and reported from them. To change the bill, void the CIS " +
        "payments recorded against it, make the correction, then record them again.",
    };
  }
  if (isCheck && message && /already settled against it/i.test(message)) {
    return {
      status: 409,
      error:
        "You've already paid more than that against this bill. Reduce it to at least the amount " +
        "settled so far, or void the supplier payments that no longer fit and record them again.",
    };
  }
  if (isCheck) {
    return { status: 409, error: "That change isn't allowed on this bill." };
  }
  return null;
}
