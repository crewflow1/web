import { describe, it, expect } from "vitest";
import { invoiceSubscriptionId } from "@/lib/stripe/events";

/**
 * Regression guard for the billing_invoices kind mislabel.
 *
 * A live test-mode walkthrough (2026-10-27) showed the sandbox account sending
 * invoices in the 2025-era API shape, where the top-level `Invoice.subscription`
 * field is gone and the reference lives at
 * `parent.subscription_details.subscription`. The webhook handler read only the
 * legacy field, so every recurring subscription invoice was written with
 * kind='setup_fee'. `invoiceSubscriptionId` resolves the ref across API shapes;
 * the fixtures below pin each known location (newest-shape fixture copied from an
 * actual captured invoice.paid payload).
 */

// Shape copied from a real invoice.paid payload (billing_reason=subscription_create).
const NEW_SHAPE_INVOICE = {
  object: "invoice",
  subscription: null, // deprecated/removed on this API version
  billing_reason: "subscription_create",
  parent: {
    type: "subscription_details",
    quote_details: null,
    subscription_details: {
      metadata: {},
      subscription: "sub_1UVK3BDMfxqqS1S5SQ5l5hL6",
    },
  },
  lines: {
    data: [
      {
        parent: {
          type: "subscription_item_details",
          invoice_item_details: null,
          subscription_item_details: {
            proration: false,
            invoice_item: null,
            subscription: "sub_1UVK3BDMfxqqS1S5SQ5l5hL6",
            subscription_item: "si_VWMmsy7njrL1om",
          },
        },
      },
    ],
  },
};

describe("invoiceSubscriptionId", () => {
  it("resolves the subscription from parent.subscription_details (current API shape)", () => {
    // The whole point of the fix: no top-level `subscription`, yet this is a
    // recurring invoice and must resolve so kind='subscription'.
    expect(invoiceSubscriptionId(NEW_SHAPE_INVOICE)).toBe(
      "sub_1UVK3BDMfxqqS1S5SQ5l5hL6",
    );
  });

  it("falls back to the line item's subscription_item_details when parent is absent", () => {
    const inv = {
      subscription: null,
      parent: null,
      lines: {
        data: [
          {
            parent: {
              subscription_item_details: { subscription: "sub_from_line" },
            },
          },
        ],
      },
    };
    expect(invoiceSubscriptionId(inv)).toBe("sub_from_line");
  });

  it("still reads the legacy top-level string field (older API versions)", () => {
    expect(invoiceSubscriptionId({ subscription: "sub_legacy" })).toBe(
      "sub_legacy",
    );
  });

  it("reads a legacy expanded subscription object ({ id })", () => {
    expect(
      invoiceSubscriptionId({ subscription: { id: "sub_expanded" } }),
    ).toBe("sub_expanded");
  });

  it("returns null for a genuine one-off invoice (no subscription anywhere)", () => {
    const oneOff = {
      subscription: null,
      billing_reason: "manual",
      parent: null,
      lines: { data: [{ parent: { invoice_item_details: {} } }] },
    };
    expect(invoiceSubscriptionId(oneOff)).toBeNull();
  });

  it("is null-safe for missing / malformed input", () => {
    expect(invoiceSubscriptionId(null)).toBeNull();
    expect(invoiceSubscriptionId(undefined)).toBeNull();
    expect(invoiceSubscriptionId("not-an-object")).toBeNull();
    expect(invoiceSubscriptionId({})).toBeNull();
    expect(invoiceSubscriptionId({ parent: {} })).toBeNull();
    expect(invoiceSubscriptionId({ lines: { data: [] } })).toBeNull();
  });
});
