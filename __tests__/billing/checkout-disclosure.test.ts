import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CHECKOUT_CUSTOM_TEXT_MAX,
  SETUP_FEE_CHECKOUT_NOTICE,
  SUBSCRIPTION_CHECKOUT_NOTICE,
  checkoutCustomText,
} from "@/lib/billing/checkout-disclosure";

/** Founder billing policy 2026-11-16: conditions disclosed in Checkout before payment. */
describe("checkout disclosure", () => {
  it("setup fee: one-off, separate, non-refundable even on cancellation, statutory exception kept", () => {
    expect(SETUP_FEE_CHECKOUT_NOTICE).toMatch(/one-off setup fee/);
    expect(SETUP_FEE_CHECKOUT_NOTICE).toMatch(/charged once, separately from the monthly subscription/);
    expect(SETUP_FEE_CHECKOUT_NOTICE).toMatch(/non-refundable — including if you later cancel/);
    expect(SETUP_FEE_CHECKOUT_NOTICE).toMatch(/except where the law requires a refund/);
  });

  it("subscription: cancel from Settings, end of paid month, full access until then, no proration, setup fee separate", () => {
    expect(SUBSCRIPTION_CHECKOUT_NOTICE).toMatch(/cancel at any time from Settings → Billing without contacting us/);
    expect(SUBSCRIPTION_CHECKOUT_NOTICE).toMatch(/end of the current paid month/);
    expect(SUBSCRIPTION_CHECKOUT_NOTICE).toMatch(/keep full access until then/);
    expect(SUBSCRIPTION_CHECKOUT_NOTICE).toMatch(/Unused days are not refunded except where the law or your agreement/);
    expect(SUBSCRIPTION_CHECKOUT_NOTICE).toMatch(/setup fee is separate and non-refundable/);
  });

  it("fits Stripe's custom_text limit", () => {
    for (const m of [SETUP_FEE_CHECKOUT_NOTICE, SUBSCRIPTION_CHECKOUT_NOTICE]) {
      expect(m.length).toBeLessThanOrEqual(CHECKOUT_CUSTOM_TEXT_MAX);
    }
    expect(checkoutCustomText("setup_fee").submit.message).toBe(SETUP_FEE_CHECKOUT_NOTICE);
    expect(checkoutCustomText("subscription").submit.message).toBe(SUBSCRIPTION_CHECKOUT_NOTICE);
  });

  it("every customer-facing setup-fee / subscription Checkout session carries the disclosure (source pin)", () => {
    const files = [
      "app/admin/customers/[id]/_stripe-actions.ts",
      "lib/stripe/demo-checkout.ts",
      "server/services/self-serve-billing.ts",
    ];
    for (const f of files) {
      const src = readFileSync(resolve(__dirname, "../..", f), "utf8");
      const creates = (src.match(/checkout\.sessions\.create\(/g) ?? []).length;
      const disclosures = (src.match(/custom_text: checkoutCustomText\(/g) ?? []).length;
      expect(disclosures, f).toBe(creates);
    }
  });
});
