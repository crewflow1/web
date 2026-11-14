/**
 * Self-serve subscription CANCELLATION — the pure rules (no DB, no Stripe SDK).
 *
 * Everything here is deterministic and unit-testable from fixtures: which Stripe
 * subscription statuses can still bill, the idempotency key, the pro-rata refund
 * REVIEW computation, Stripe error classification, and — deliberately in one
 * place — the EXACT statements the product makes to a customer who cancels.
 *
 * ── POLICY, AND WHERE IT COMES FROM ─────────────────────────────────────────
 * Cancellation is IMMEDIATE: the Stripe subscription is terminated now, there is
 * no further renewal charge, and workspace access ends now.
 *
 * Refunds: the published terms (app/terms/page.tsx, "Billing") say "Refunds are
 * issued for unused prepaid time when you cancel; pro-rata." The product
 * therefore may not tell a customer that nothing is refunded. It also does NOT
 * move money automatically: no proration credit is generated (`prorate: false`)
 * and no refund is created by code. When unused prepaid time exists the
 * cancellation is flagged `refund_review = 'pending'` with an ESTIMATE for HQ,
 * and a human issues the refund in Stripe. See CANCELLATION-DESIGN.md §Refunds.
 *
 * Data: the terms say "When you cancel, we delete it within 30 days, except
 * where tax law (HMRC) obliges us to retain it."
 */

/** Days after cancellation within which the terms say tenant data is deleted. */
export const CANCELLATION_DATA_DELETION_DAYS = 30;

/** Where a lapsed (cancelled / suspended) org's owner manages billing + data. */
export const ACCOUNT_BILLING_PATH = "/account/billing";

// ---------------------------------------------------------------------------
// Kill switch
// ---------------------------------------------------------------------------

/**
 * Incident rollback lever. Cancellation is AVAILABLE unless this env var is the
 * literal "true". Read at call time (not from the frozen `env` snapshot) so the
 * behaviour is testable by flipping process.env.
 */
export function isSelfServeCancellationDisabled(): boolean {
  return process.env.BILLING_SELF_SERVE_CANCELLATION_DISABLED === "true";
}

// ---------------------------------------------------------------------------
// Stripe subscription statuses
// ---------------------------------------------------------------------------

/**
 * Statuses in which a Stripe subscription can still produce a charge or an
 * invoice, now or later. `canceled` and `incomplete_expired` are terminal.
 * `paused` and `incomplete` are included on purpose: a paused subscription
 * resumes billing, and an incomplete one is still awaiting its first payment —
 * "never charged again" means terminating both.
 */
export const LIVE_STRIPE_SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "unpaid",
  "incomplete",
  "paused",
] as const;

export function isLiveStripeSubscriptionStatus(status: unknown): boolean {
  return (
    typeof status === "string" &&
    (LIVE_STRIPE_SUBSCRIPTION_STATUSES as readonly string[]).includes(status)
  );
}

/**
 * Stripe idempotency key for cancelling one subscription of one org. Stable per
 * (org, subscription) so a double-click, two owners, or a retry after a timeout
 * all replay the SAME Stripe request instead of issuing a second one.
 */
export function cancellationIdempotencyKey(orgId: string, subscriptionId: string): string {
  return `crewflow-cancel:${orgId}:${subscriptionId}`;
}

// ---------------------------------------------------------------------------
// Refund review (pro-rata ESTIMATE for HQ — never shown to the customer)
// ---------------------------------------------------------------------------

export type RefundReviewInput = {
  /** The subscription's status immediately BEFORE it was cancelled. */
  statusBeforeCancel: string;
  /** Unix seconds. */
  currentPeriodStart: number | null;
  /** Unix seconds. */
  currentPeriodEnd: number | null;
  /** Per-unit recurring amount in the currency's minor unit (pence). */
  unitAmountMinor: number | null;
  quantity: number | null;
  currency: string | null;
  /** Unix seconds — the moment of cancellation. */
  cancelledAt: number;
};

export type RefundReview = {
  review: "pending" | "not_applicable";
  /** Why — a stable code HQ can read in the audit trail. */
  basis:
    | "unused_prepaid_time"
    | "not_in_paid_period"
    | "period_unknown"
    | "period_elapsed"
    | "no_recurring_amount";
  /** Fraction of the paid period that had not elapsed, 0..1 (4 dp). */
  unusedFraction: number | null;
  /** Pro-rata ESTIMATE, minor units, before tax / discounts / credits. */
  estimateMinor: number | null;
  currency: string | null;
  periodStart: string | null;
  periodEnd: string | null;
};

const iso = (unix: number | null): string | null =>
  typeof unix === "number" && unix > 0 ? new Date(unix * 1000).toISOString() : null;

/**
 * Is a refund REVIEW owed under the terms, and roughly how much?
 *
 * Only an `active` subscription has prepaid time: `trialing` has paid nothing,
 * and `past_due` / `unpaid` / `incomplete` have NOT paid for the current period
 * (the invoice is the thing that is outstanding), so nothing is prepaid.
 *
 * The estimate is list price × unused fraction. It ignores tax, coupons and
 * account credit on purpose — it is a prompt for a human, not a figure to pay.
 */
export function computeRefundReview(input: RefundReviewInput): RefundReview {
  const base = {
    unusedFraction: null,
    estimateMinor: null,
    currency: input.currency ? input.currency.toUpperCase() : null,
    periodStart: iso(input.currentPeriodStart),
    periodEnd: iso(input.currentPeriodEnd),
  };
  if (input.statusBeforeCancel !== "active") {
    return { review: "not_applicable", basis: "not_in_paid_period", ...base };
  }
  const start = input.currentPeriodStart;
  const end = input.currentPeriodEnd;
  if (typeof start !== "number" || typeof end !== "number" || end <= start) {
    // Paid and active but we cannot see the period: a human must look.
    return { review: "pending", basis: "period_unknown", ...base };
  }
  if (input.cancelledAt >= end) {
    return { review: "not_applicable", basis: "period_elapsed", ...base, unusedFraction: 0 };
  }
  const unused = Math.min(1, Math.max(0, (end - input.cancelledAt) / (end - start)));
  const unusedFraction = Math.round(unused * 10_000) / 10_000;
  const unit = input.unitAmountMinor;
  const qty = input.quantity && input.quantity > 0 ? input.quantity : 1;
  if (typeof unit !== "number" || unit <= 0) {
    return { review: "not_applicable", basis: "no_recurring_amount", ...base, unusedFraction };
  }
  return {
    review: "pending",
    basis: "unused_prepaid_time",
    ...base,
    unusedFraction,
    estimateMinor: Math.round(unit * qty * unused),
  };
}

// ---------------------------------------------------------------------------
// Stripe error classification
// ---------------------------------------------------------------------------

export type StripeCancelErrorKind =
  /** Outcome UNKNOWN — the request may or may not have reached Stripe. */
  | "timeout"
  /** Stripe says the subscription does not exist / is already cancelled. */
  | "gone"
  /** The key is missing a scope or is invalid — an operator problem. */
  | "auth"
  | "rate_limited"
  | "other";

/**
 * Classify a thrown Stripe SDK error WITHOUT importing the SDK (works on the
 * plain `{ type, code, statusCode, message }` shape, so fixtures can drive it).
 */
export function classifyStripeCancelError(e: unknown): StripeCancelErrorKind {
  if (!e || typeof e !== "object") return "other";
  const err = e as { type?: unknown; code?: unknown; statusCode?: unknown; message?: unknown };
  const type = typeof err.type === "string" ? err.type : "";
  const code = typeof err.code === "string" ? err.code : "";
  const message = typeof err.message === "string" ? err.message : "";
  if (type === "StripeConnectionError" || type === "StripeAPIError" || /timed? ?out|ETIMEDOUT|ECONNRESET/i.test(message)) {
    return "timeout";
  }
  if (code === "resource_missing" || err.statusCode === 404 || /no such subscription/i.test(message)) {
    return "gone";
  }
  if (type === "StripeAuthenticationError" || type === "StripePermissionError") return "auth";
  if (type === "StripeRateLimitError" || err.statusCode === 429) return "rate_limited";
  return "other";
}

// ---------------------------------------------------------------------------
// What we tell the customer — the single source of the cancellation copy
// ---------------------------------------------------------------------------

/**
 * The exact statements made on the confirmation step, the success state and in
 * the confirmation email. One place, so the UI, the email and the design doc
 * cannot drift — and so a change of policy is a one-file edit.
 *
 * Each line is true of the implementation:
 *   stops    — the Stripe subscription is cancelled immediately (not at period
 *              end) and organizations.status becomes 'cancelled'.
 *   charges  — no renewal is ever generated for a cancelled subscription, and
 *              automatic collection is switched off on any open/draft invoice.
 *   unpaid   — an unpaid invoice is NOT voided; it stays outstanding, uncollected.
 *   refund   — restates the terms; nothing is refunded by code.
 *   data     — restates the terms; export stays available to the owner.
 */
export const CANCELLATION_COPY = {
  stops:
    "Your subscription ends immediately and everyone in your company loses access to the workspace straight away, including you.",
  charges:
    "We won't take any further payments. No renewal will be charged, and we won't try your card again for any invoice.",
  unpaid:
    "If an invoice is still unpaid, we stop trying to collect it from your card. It stays on your account as outstanding, and we'll contact you about it.",
  refund:
    "Our terms give you a pro-rata refund for prepaid time you haven't used. It isn't paid automatically when you cancel: we work out what's due and refund it to your original payment method, then email you to confirm.",
  data: `Your data isn't deleted when you cancel. Under our terms it's deleted within ${CANCELLATION_DATA_DELETION_DAYS} days of cancellation, except records tax law requires us to keep. You can still sign in to download an export and your invoices until then.`,
  reactivate:
    "Changed your mind? Ask us to reactivate from your billing page and we'll get you set up again.",
} as const;

/** Human copy for each refusal the cancel action can return. */
export const CANCELLATION_ERROR_COPY: Record<string, string> = {
  forbidden: "Only the account owner can cancel the subscription.",
  disabled:
    "Cancelling online is temporarily unavailable. Email hello@crewflow.uk and we'll cancel it for you today.",
  org_changed:
    "You've switched company since opening this page. Reload and check you're cancelling the right one.",
  org_not_found: "We couldn't load your company. Reload and try again.",
  in_progress: "A cancellation is already being processed. Give it a moment, then reload this page.",
  billing_unavailable:
    "We couldn't reach our payment provider, so nothing has been cancelled. Try again in a minute, or email hello@crewflow.uk.",
  billing_mismatch:
    "We couldn't safely match your subscription, so nothing has been cancelled. We've alerted our team and will cancel it for you. Email hello@crewflow.uk if you need it done now.",
  stripe_timeout:
    "We couldn't confirm the cancellation with our payment provider, so we haven't marked it cancelled. Try again: it's safe to repeat.",
  stripe_error:
    "Our payment provider refused the cancellation, so nothing has changed. Try again, or email hello@crewflow.uk and we'll cancel it for you.",
  invalid: "That request wasn't valid. Reload the page and try again.",
  unexpected:
    "Something went wrong and we couldn't confirm the cancellation. Reload this page to see whether it went through before trying again.",
};
