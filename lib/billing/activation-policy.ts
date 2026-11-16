/**
 * Billing policy (founder requirement, 2026-11-16): a company is activated only once BOTH the
 * £1,000 setup fee and the £500/month subscription have succeeded. HQ may waive the fee.
 *
 * The database enforces the activation half (apply_stripe_subscription_state, migration
 * 20261352000000 — the same two values); HQ's checkout enforces the order (fee first).
 * Keep this list and the SQL in step: __tests__/billing/activation-policy.test.ts pins both.
 */
export const SETUP_FEE_SATISFIED = ["paid", "waived"] as const;

export function setupFeeSatisfied(status: string | null | undefined): boolean {
  return (SETUP_FEE_SATISFIED as readonly string[]).includes(status ?? "");
}
