import { afterEach, describe, expect, it } from "vitest";
import {
  CANCELLATION_COPY,
  CANCELLATION_ERROR_COPY,
  cancellationIdempotencyKey,
  classifyStripeCancelError,
  computeRefundReview,
  isLiveStripeSubscriptionStatus,
  isSelfServeCancellationDisabled,
  LIVE_STRIPE_SUBSCRIPTION_STATUSES,
} from "@/lib/billing/cancellation";
import { buildCancellationEmail, buildCancellationScheduleEmail } from "@/lib/billing/cancellation-email";
import { SUBSCRIPTION_STATUSES } from "@/lib/billing/subscription-state";

/**
 * Subscription cancellation — the PURE rules (no DB, no Stripe).
 */

const DAY = 86_400;
const START = 1_800_000_000;

describe("which Stripe subscription statuses can still bill", () => {
  it("every status that is not terminal is live", () => {
    for (const s of SUBSCRIPTION_STATUSES) {
      const terminal = s === "canceled" || s === "incomplete_expired";
      expect(isLiveStripeSubscriptionStatus(s), s).toBe(!terminal);
    }
  });
  it("covers the whole Stripe enum — a new status must be classified", () => {
    const classified = new Set<string>([
      ...LIVE_STRIPE_SUBSCRIPTION_STATUSES,
      "canceled",
      "incomplete_expired",
    ]);
    expect([...SUBSCRIPTION_STATUSES].filter((s) => !classified.has(s))).toEqual([]);
  });
  it("an unknown value is not treated as live or as a string coincidence", () => {
    expect(isLiveStripeSubscriptionStatus("cancelled")).toBe(false);
    expect(isLiveStripeSubscriptionStatus(undefined)).toBe(false);
  });
});

describe("idempotency key", () => {
  it("is stable per (org, subscription) and distinct across either", () => {
    expect(cancellationIdempotencyKey("o1", "sub_1")).toBe(cancellationIdempotencyKey("o1", "sub_1"));
    expect(cancellationIdempotencyKey("o1", "sub_1")).not.toBe(cancellationIdempotencyKey("o2", "sub_1"));
    expect(cancellationIdempotencyKey("o1", "sub_1")).not.toBe(cancellationIdempotencyKey("o1", "sub_2"));
  });
});

describe("refund review — a flag and an estimate, never a payment", () => {
  const base = {
    currentPeriodStart: START,
    currentPeriodEnd: START + 30 * DAY,
    unitAmountMinor: 50_000,
    quantity: 1,
    currency: "gbp",
  };

  it("active, 10 of 30 days used → pending, two-thirds of the price", () => {
    const r = computeRefundReview({ ...base, statusBeforeCancel: "active", cancelledAt: START + 10 * DAY });
    expect(r.review).toBe("pending");
    expect(r.basis).toBe("unused_prepaid_time");
    expect(r.unusedFraction).toBe(0.6667);
    expect(r.estimateMinor).toBe(33_333);
    expect(r.currency).toBe("GBP");
  });

  it("trialing → nothing was paid, nothing is prepaid", () => {
    const r = computeRefundReview({ ...base, statusBeforeCancel: "trialing", cancelledAt: START + DAY });
    expect(r.review).toBe("not_applicable");
    expect(r.estimateMinor).toBeNull();
  });

  it.each(["past_due", "unpaid", "incomplete", "paused"])(
    "%s → the current period is not paid for, so no refund review",
    (status) => {
      const r = computeRefundReview({ ...base, statusBeforeCancel: status, cancelledAt: START + DAY });
      expect(r.review).toBe("not_applicable");
      expect(r.basis).toBe("not_in_paid_period");
    },
  );

  it("cancelled at the very end of the period → nothing unused", () => {
    const r = computeRefundReview({ ...base, statusBeforeCancel: "active", cancelledAt: START + 30 * DAY });
    expect(r.review).toBe("not_applicable");
    expect(r.basis).toBe("period_elapsed");
  });

  it("active but the period is unknown → a human must look (pending, no figure)", () => {
    const r = computeRefundReview({
      ...base,
      currentPeriodStart: null,
      currentPeriodEnd: null,
      statusBeforeCancel: "active",
      cancelledAt: START,
    });
    expect(r.review).toBe("pending");
    expect(r.basis).toBe("period_unknown");
    expect(r.estimateMinor).toBeNull();
  });

  it("a free (£0) subscription has nothing to refund", () => {
    const r = computeRefundReview({ ...base, unitAmountMinor: 0, statusBeforeCancel: "active", cancelledAt: START + DAY });
    expect(r.review).toBe("not_applicable");
  });

  it("quantity scales the estimate; it never exceeds the period's price", () => {
    const r = computeRefundReview({ ...base, quantity: 3, statusBeforeCancel: "active", cancelledAt: START - DAY });
    expect(r.unusedFraction).toBe(1);
    expect(r.estimateMinor).toBe(150_000);
  });
});

describe("Stripe error classification", () => {
  it("a connection error is an UNKNOWN outcome, not a refusal", () => {
    expect(classifyStripeCancelError({ type: "StripeConnectionError", message: "x" })).toBe("timeout");
    expect(classifyStripeCancelError(new Error("Request timed out"))).toBe("timeout");
    expect(classifyStripeCancelError({ type: "StripeAPIError", statusCode: 500 })).toBe("timeout");
  });
  it("a missing subscription is 'gone'", () => {
    expect(classifyStripeCancelError({ code: "resource_missing", statusCode: 404 })).toBe("gone");
    expect(classifyStripeCancelError({ message: "No such subscription: 'sub_1'" })).toBe("gone");
  });
  it("auth / permission / rate limit / anything else", () => {
    expect(classifyStripeCancelError({ type: "StripePermissionError" })).toBe("auth");
    expect(classifyStripeCancelError({ type: "StripeAuthenticationError" })).toBe("auth");
    expect(classifyStripeCancelError({ type: "StripeRateLimitError" })).toBe("rate_limited");
    expect(classifyStripeCancelError({ type: "StripeInvalidRequestError" })).toBe("other");
    expect(classifyStripeCancelError(null)).toBe("other");
  });
});

describe("kill switch", () => {
  const original = process.env.BILLING_SELF_SERVE_CANCELLATION_DISABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.BILLING_SELF_SERVE_CANCELLATION_DISABLED;
    else process.env.BILLING_SELF_SERVE_CANCELLATION_DISABLED = original;
  });
  it("cancellation is AVAILABLE by default and for any value but the literal 'true'", () => {
    delete process.env.BILLING_SELF_SERVE_CANCELLATION_DISABLED;
    expect(isSelfServeCancellationDisabled()).toBe(false);
    process.env.BILLING_SELF_SERVE_CANCELLATION_DISABLED = "false";
    expect(isSelfServeCancellationDisabled()).toBe(false);
    process.env.BILLING_SELF_SERVE_CANCELLATION_DISABLED = "1";
    expect(isSelfServeCancellationDisabled()).toBe(false);
  });
  it("'true' disables it", () => {
    process.env.BILLING_SELF_SERVE_CANCELLATION_DISABLED = "true";
    expect(isSelfServeCancellationDisabled()).toBe(true);
  });
});

describe("what the customer is told", () => {
  const D = "16 December 2026";
  const all = Object.values(CANCELLATION_COPY)
    .map((v) => (typeof v === "function" ? v(D) : v))
    .join(" ");

  it("a paying customer is told the EXACT end date and that they keep full access until then", () => {
    expect(CANCELLATION_COPY.scheduledAccess(D)).toMatch(/won't renew/);
    expect(CANCELLATION_COPY.scheduledAccess(D)).toContain(`full access until ${D}`);
    expect(CANCELLATION_COPY.scheduledAccess(D)).toMatch(/staff lose access/);
    expect(CANCELLATION_COPY.scheduledAccess(D)).toMatch(/read-only access to download data and invoices/);
    expect(CANCELLATION_COPY.undo(D)).toContain(`any time before ${D}`);
    expect(CANCELLATION_COPY.charges).toMatch(/won't take any further subscription payments/);
  });

  it("the immediate wording is reserved for a workspace with nothing left to renew", () => {
    expect(CANCELLATION_COPY.immediateAccess).toMatch(/no paid period left/);
  });

  it("refunds: none automatically, setup fee non-refundable, but the customer's agreement / the law still win", () => {
    expect(CANCELLATION_COPY.refund).toMatch(/no automatic refund for the rest of the current period/);
    expect(CANCELLATION_COPY.refund).toMatch(/setup fee is a one-off charge and isn't refunded when you cancel/);
    expect(CANCELLATION_COPY.refund).toMatch(/If your agreement with us or the law entitles you to a refund/);
    expect(all).not.toMatch(/pro-rata/i);
    expect(all).not.toMatch(/refunded (instantly|immediately|automatically)/i);
  });

  it("data: cancelling never deletes it, and no deletion deadline is promised", () => {
    expect(CANCELLATION_COPY.data).toMatch(/Cancelling never deletes your data/);
    expect(all).not.toMatch(/deleted within|delete it within|\d+ days of cancellation/i);
  });

  it("says an unpaid invoice stays outstanding (it is not written off)", () => {
    expect(CANCELLATION_COPY.unpaid).toMatch(/stays on your account as outstanding/);
  });

  it("no guilt-trip, no pressure", () => {
    expect(all).not.toMatch(/are you sure|sorry to see|we'll miss|lose everything|last chance|special offer|discount/i);
  });

  it("every refusal the action can return has human copy", () => {
    for (const code of [
      "forbidden",
      "disabled",
      "org_changed",
      "org_not_found",
      "in_progress",
      "billing_unavailable",
      "billing_mismatch",
      "stripe_timeout",
      "stripe_error",
      "invalid",
      "unexpected",
      "period_changed",
      "expired",
    ]) {
      expect(CANCELLATION_ERROR_COPY[code], code).toBeTruthy();
    }
  });

  it("no refusal claims the subscription WAS cancelled", () => {
    for (const [code, msg] of Object.entries(CANCELLATION_ERROR_COPY)) {
      // "nothing has been cancelled" is the honest phrasing several use; what
      // must never appear is an unqualified claim of success.
      expect(msg, code).not.toMatch(/(?<!nothing )has been cancelled|is now cancelled|successfully/i);
    }
  });
});

describe("confirmation email", () => {
  it("repeats the confirmation-step statements and links billing + terms", () => {
    const m = buildCancellationEmail({
      orgName: "Acme Builders",
      appUrl: "https://app.example.test/",
      hadSubscription: true,
    });
    expect(m.subject).toContain("Acme Builders");
    expect(m.text).toContain(CANCELLATION_COPY.charges);
    expect(m.text).toContain(CANCELLATION_COPY.refund);
    expect(m.text).toContain(CANCELLATION_COPY.unpaid);
    expect(m.text).toContain(CANCELLATION_COPY.data);
    expect(m.text).toContain("https://app.example.test/account/billing");
    expect(m.html).toContain('href="https://app.example.test/account/billing"');
    expect(m.html).toContain('href="https://app.example.test/terms"');
  });

  it("with no card subscription it does not talk about refunds or unpaid invoices", () => {
    const m = buildCancellationEmail({
      orgName: "Acme",
      appUrl: "https://app.example.test",
      hadSubscription: false,
    });
    expect(m.text).toMatch(/no card subscription/);
    expect(m.text).not.toContain(CANCELLATION_COPY.refund);
    expect(m.text).not.toContain(CANCELLATION_COPY.unpaid);
  });

  it("the ENDED email is accurate at period end (never says 'effective immediately')", () => {
    const m = buildCancellationEmail({ orgName: "Acme", appUrl: "https://app.example.test", hadSubscription: true });
    expect(m.subject).toMatch(/has ended/);
    expect(m.text).not.toMatch(/effective immediately/);
  });
});

describe("cancellation SCHEDULED / WITHDRAWN emails", () => {
  const at = Date.UTC(2026, 11, 16, 12) / 1000;
  it("scheduled: subject and body carry the exact final access date, the no-refund statement and how to undo", () => {
    const m = buildCancellationScheduleEmail({ orgName: "Acme", appUrl: "https://app.example.test/", kind: "scheduled", at });
    expect(m.subject).toBe("Your CrewFlow subscription for Acme ends on 16 December 2026");
    expect(m.text).toContain("Your final day of access is 16 December 2026");
    expect(m.text).toContain(CANCELLATION_COPY.refund);
    expect(m.text).toContain(CANCELLATION_COPY.undo("16 December 2026"));
    expect(m.text).toContain(CANCELLATION_COPY.data);
    expect(m.html).toContain('href="https://app.example.test/account/billing"');
    expect(m.html).not.toMatch(/<script/i);
  });
  it("withdrawn: says the subscription continues and when it next renews", () => {
    const m = buildCancellationScheduleEmail({ orgName: "Acme", appUrl: "https://app.example.test", kind: "resumed", at });
    expect(m.subject).toMatch(/will continue/);
    expect(m.text).toContain("next renews on 16 December 2026");
  });
  it("org names are HTML-escaped", () => {
    const m = buildCancellationScheduleEmail({ orgName: "<b>Acme</b>", appUrl: "https://x.test", kind: "scheduled", at });
    expect(m.html).not.toContain("<b>Acme</b>");
  });

  it("escapes the organisation name in HTML", () => {
    const m = buildCancellationEmail({
      orgName: `<img src=x onerror=alert(1)> & "Co"`,
      appUrl: "https://app.example.test",
      hadSubscription: true,
    });
    expect(m.html).not.toContain("<img");
    expect(m.html).toContain("&lt;img");
  });
});
