/**
 * Terms shown in Stripe Checkout, right above the pay button, BEFORE the
 * customer pays (founder billing policy 2026-11-16). Stripe Checkout already
 * shows the amount; these state the conditions. Stripe caps the message at
 * 1,200 characters (pinned by a unit test).
 *
 * Keep in step with the Terms of Service and CANCELLATION_COPY
 * (lib/billing/cancellation.ts). The "except where the law requires" wording
 * preserves statutory rights; see docs/programme/cancellation/TERMS-UPDATE-DRAFT.md.
 */
export const SETUP_FEE_CHECKOUT_NOTICE =
  "This is CrewFlow's one-off setup fee. It is charged once, separately from the monthly subscription, and is non-refundable — including if you later cancel — except where the law requires a refund. Terms: crewflow.uk/terms";

export const SUBSCRIPTION_CHECKOUT_NOTICE =
  "Your CrewFlow subscription renews every month until you cancel. You can cancel at any time from Settings → Billing without contacting us. Cancellation takes effect at the end of the current paid month: you keep full access until then and are not charged again. Unused days are not refunded except where the law or your agreement with us requires it. The setup fee is separate and non-refundable. Terms: crewflow.uk/terms";

export const CHECKOUT_CUSTOM_TEXT_MAX = 1200;

/** Stripe Checkout `custom_text` for a session of the given kind. */
export function checkoutCustomText(kind: "setup_fee" | "subscription"): {
  submit: { message: string };
} {
  return {
    submit: { message: kind === "setup_fee" ? SETUP_FEE_CHECKOUT_NOTICE : SUBSCRIPTION_CHECKOUT_NOTICE },
  };
}
