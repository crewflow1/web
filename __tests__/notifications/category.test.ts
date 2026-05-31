import { describe, it, expect } from "vitest";
import {
  notificationCategoryForType,
  NOTIFICATION_CATEGORY_LABEL,
} from "@/lib/notifications/types";

/**
 * L1 — invoice/payment notifications were showing under "Other" because the
 * activity-log → notifications DB trigger never sets `category`, so the
 * column default ("other") stuck. notificationCategoryForType backfills a
 * sensible category at read time, mapping onto the existing CHECK-allowed
 * categories (no migration needed).
 */
describe("notificationCategoryForType", () => {
  it("maps money-received events to the Payment category", () => {
    for (const type of [
      "payment.recorded",
      "invoice.paid",
      "invoice.payment_failed",
      "invoice.payment_action_required",
      "bank.matched",
      "bank.reconciled",
    ]) {
      expect(notificationCategoryForType(type, "other")).toBe("stripe");
      // The user-facing label for the stripe category is "Payment".
      expect(NOTIFICATION_CATEGORY_LABEL["stripe"]).toBe("Payment");
    }
  });

  it("maps invoice-lifecycle events to the Billing category", () => {
    for (const type of [
      "invoice.created",
      "invoice.draft",
      "invoice.finalized",
      "invoice.sent",
      "invoice.voided",
      "invoice.overdue",
    ]) {
      expect(notificationCategoryForType(type, "other")).toBe("billing");
      expect(NOTIFICATION_CATEGORY_LABEL["billing"]).toBe("Billing");
    }
  });

  it("never overrides an explicitly-set category", () => {
    // A real Stripe/billing/support row keeps its stored category even if
    // the type would otherwise map elsewhere.
    expect(notificationCategoryForType("invoice.paid", "billing")).toBe(
      "billing",
    );
    expect(notificationCategoryForType("payment.recorded", "support")).toBe(
      "support",
    );
    expect(notificationCategoryForType("invoice.sent", "stripe")).toBe(
      "stripe",
    );
  });

  it("leaves unrelated 'other' events as other", () => {
    expect(notificationCategoryForType("quote.approved", "other")).toBe(
      "other",
    );
    expect(notificationCategoryForType("job.assigned", "other")).toBe("other");
    expect(notificationCategoryForType("", "other")).toBe("other");
  });
});
