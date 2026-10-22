import { describe, it, expect, beforeEach } from "vitest";
import {
  ANALYTICS_EVENTS,
  isAnalyticsEvent,
  isProhibitedKey,
  sanitizeEventProperties,
  setAnalyticsSink,
  trackEvent,
  type AnalyticsEventName,
  type SafeEventProperties,
} from "@/lib/analytics/events";

describe("event taxonomy", () => {
  it("event names are a closed, recognised set", () => {
    expect(isAnalyticsEvent(ANALYTICS_EVENTS.QUOTE_SENT)).toBe(true);
    expect(isAnalyticsEvent(ANALYTICS_EVENTS.AI_GOVERNOR_REJECTED)).toBe(true);
    expect(isAnalyticsEvent("some_made_up_event")).toBe(false);
  });
});

describe("privacy denylist (isProhibitedKey)", () => {
  it.each([
    "customer_name",
    "contact_email",
    "phone",
    "mobile_number",
    "site_address",
    "postcode",
    "note",
    "invoice_description",
    "quote_content",
    "message_body",
    "invoice_amount",
    "total_value",
    "unit_price",
    "account_balance",
    "access_token",
    "api_key",
    "apikey",
    "password",
    "secret",
    "iban",
  ])("drops prohibited key %s", (k) => {
    expect(isProhibitedKey(k)).toBe(true);
  });

  it.each(["org_id", "plan", "role_type", "stage", "feature", "count", "source"])(
    "allows safe key %s",
    (k) => {
      expect(isProhibitedKey(k)).toBe(false);
    },
  );
});

describe("sanitizeEventProperties", () => {
  it("strips prohibited keys, keeps safe primitives", () => {
    const out = sanitizeEventProperties({
      org_id: "org_abc",
      plan: "pro",
      line_count: 4,
      has_vat: true,
      customer_name: "Mrs Hemingway", // prohibited
      customer_email: "a@b.com", // prohibited
      invoice_amount: 12450, // prohibited (money)
      notes: "chase this", // prohibited (free text)
    });
    expect(out).toEqual({ org_id: "org_abc", plan: "pro", line_count: 4, has_vat: true });
  });

  it("drops non-primitive values (objects/arrays carry PII)", () => {
    const out = sanitizeEventProperties({
      org_id: "org_1",
      customer: { name: "x", email: "y" },
      lines: [1, 2, 3],
      fn: () => 1,
      nothing: null,
      missing: undefined,
    });
    expect(out).toEqual({ org_id: "org_1" });
  });

  it("drops empty and over-long strings (free-text smell)", () => {
    const long = "x".repeat(200);
    const out = sanitizeEventProperties({ stage: "won", empty: "", blurb: long });
    expect(out).toEqual({ stage: "won" });
  });

  it("drops non-finite numbers", () => {
    const out = sanitizeEventProperties({ n: Number.NaN, m: Infinity, ok: 3 });
    expect(out).toEqual({ ok: 3 });
  });

  it("returns {} for undefined / non-object input", () => {
    expect(sanitizeEventProperties(undefined)).toEqual({});
    expect(sanitizeEventProperties(42 as unknown as Record<string, unknown>)).toEqual({});
  });
});

describe("trackEvent", () => {
  beforeEach(() => setAnalyticsSink(null));

  it("is a silent no-op (never throws) when no sink is registered", () => {
    expect(() => trackEvent(ANALYTICS_EVENTS.JOB_CREATED, { org_id: "o" })).not.toThrow();
  });

  it("forwards the event and SANITISED properties to a registered sink", () => {
    const calls: Array<{ e: AnalyticsEventName; p: SafeEventProperties }> = [];
    setAnalyticsSink((e, p) => calls.push({ e, p }));
    trackEvent(ANALYTICS_EVENTS.INVOICE_SENT, {
      org_id: "org_9",
      customer_email: "leak@no.com", // must be stripped
      invoice_amount: 999, // must be stripped
      sent_via: "portal",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.e).toBe("invoice_sent");
    expect(calls[0]!.p).toEqual({ org_id: "org_9", sent_via: "portal" });
  });

  it("swallows a throwing sink (telemetry never breaks a flow)", () => {
    setAnalyticsSink(() => {
      throw new Error("sink boom");
    });
    expect(() => trackEvent(ANALYTICS_EVENTS.PAYMENT_RECORDED, { org_id: "o" })).not.toThrow();
  });
});
