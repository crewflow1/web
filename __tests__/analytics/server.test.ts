import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  trackEvent,
  setAnalyticsSink,
  ANALYTICS_EVENTS,
  type SafeEventProperties,
  type AnalyticsEventName,
} from "@/lib/analytics/events";
import {
  serverAnalyticsEnabled,
  createServerSink,
  ensureServerAnalyticsSink,
  __resetServerAnalyticsForTest,
} from "@/lib/analytics/server";
import { hashOrgId } from "@/lib/analytics/identity";

/**
 * Record every `posthog-node` construction + capture so the ENABLED path can be
 * proven end-to-end without any network. The provider is mocked, so these tests
 * never touch PostHog and the feature stays dark everywhere else.
 */
const posthogCaptures: Array<{
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}> = [];
const posthogCtor = vi.fn();

vi.mock("posthog-node", () => ({
  PostHog: class {
    constructor(key: string, opts: unknown) {
      posthogCtor(key, opts);
    }
    capture(payload: {
      distinctId: string;
      event: string;
      properties?: Record<string, unknown>;
    }) {
      posthogCaptures.push(payload);
    }
  },
}));

beforeEach(() => {
  __resetServerAnalyticsForTest();
  posthogCaptures.length = 0;
  posthogCtor.mockClear();
});

describe("serverAnalyticsEnabled (dark-by-default gate)", () => {
  it("is true ONLY when the opt-in flag is on AND a server key is present", () => {
    expect(serverAnalyticsEnabled({ enabled: "true", key: "phc_x" })).toBe(true);
    expect(serverAnalyticsEnabled({ enabled: "1", key: "phc_x" })).toBe(true);
    expect(serverAnalyticsEnabled({ enabled: "TRUE", key: "phc_x" })).toBe(true);
  });

  it("is false when the server key is absent/blank (even if enabled)", () => {
    expect(serverAnalyticsEnabled({ enabled: "true", key: null })).toBe(false);
    expect(serverAnalyticsEnabled({ enabled: "true", key: "" })).toBe(false);
    expect(serverAnalyticsEnabled({ enabled: "true", key: "   " })).toBe(false);
  });

  it("is false when disabled (flag off/absent) even with a key", () => {
    expect(serverAnalyticsEnabled({ enabled: "false", key: "phc_x" })).toBe(false);
    expect(serverAnalyticsEnabled({ enabled: "0", key: "phc_x" })).toBe(false);
    expect(serverAnalyticsEnabled({ enabled: null, key: "phc_x" })).toBe(false);
    expect(serverAnalyticsEnabled({ enabled: "yes", key: "phc_x" })).toBe(false);
  });

  it("is false when both are absent (the default dark state)", () => {
    expect(serverAnalyticsEnabled({})).toBe(false);
  });
});

describe("ensureServerAnalyticsSink — no-op while dark", () => {
  it("(a) registers NOTHING and stays a no-op when no server key", async () => {
    const registered = await ensureServerAnalyticsSink({ enabled: "true", key: null });
    expect(registered).toBe(false);
    expect(posthogCtor).not.toHaveBeenCalled();
    // sink is null → trackEvent is a silent no-op, nothing captured
    expect(() => trackEvent(ANALYTICS_EVENTS.JOB_CREATED, { org_id: "o" })).not.toThrow();
    expect(posthogCaptures).toHaveLength(0);
  });

  it("(b) registers NOTHING and stays a no-op when disabled", async () => {
    const registered = await ensureServerAnalyticsSink({ enabled: "false", key: "phc_x" });
    expect(registered).toBe(false);
    expect(posthogCtor).not.toHaveBeenCalled();
    expect(() => trackEvent(ANALYTICS_EVENTS.QUOTE_SENT, { org_id: "o" })).not.toThrow();
    expect(posthogCaptures).toHaveLength(0);
  });

  it("registers a working sink only when enabled + key present (activation seam)", async () => {
    const registered = await ensureServerAnalyticsSink({
      enabled: "true",
      key: "phc_secret_key",
      host: null,
    });
    expect(registered).toBe(true);
    // Constructed with the key + a default EU host (key value not asserted/logged elsewhere).
    expect(posthogCtor).toHaveBeenCalledTimes(1);
    const [, opts] = posthogCtor.mock.calls[0]!;
    expect((opts as { host: string }).host).toBe("https://eu.i.posthog.com");

    trackEvent(ANALYTICS_EVENTS.PAYMENT_RECORDED, { org_id: "org_42", method: "card" });
    expect(posthogCaptures).toEqual([
      {
        // De-identified: a stable one-way hash, never the raw org id.
        distinctId: hashOrgId("org_42"),
        event: "payment_recorded",
        properties: { org_id: "org_42", method: "card" },
      },
    ]);
    expect(posthogCaptures[0]!.distinctId).not.toBe("org_42");
  });

  it("is idempotent — a second call does not re-register", async () => {
    await ensureServerAnalyticsSink({ enabled: "true", key: "phc_x" });
    await ensureServerAnalyticsSink({ enabled: "true", key: "phc_x" });
    expect(posthogCtor).toHaveBeenCalledTimes(1);
  });
});

describe("createServerSink", () => {
  it("(c) forwards a typed event with the right (sanitised) shape to the client", () => {
    const calls: Array<{
      distinctId: string;
      event: string;
      properties?: Record<string, unknown>;
    }> = [];
    const sink = createServerSink({ capture: (p) => calls.push(p) });

    // Drive it through the real trackEvent so sanitisation is exercised too.
    setAnalyticsSink(sink);
    trackEvent(ANALYTICS_EVENTS.INVOICE_SENT, {
      org_id: "org_9",
      sent_via: "portal",
      customer_email: "leak@no.com", // PII — must be stripped
      invoice_amount: 999, // money — must be stripped
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      distinctId: hashOrgId("org_9"),
      event: "invoice_sent",
      properties: { org_id: "org_9", sent_via: "portal" },
    });
    // The person distinct id must be de-identified, not the raw org UUID.
    expect(calls[0]!.distinctId).not.toBe("org_9");
    expect(calls[0]!.distinctId.startsWith("org_")).toBe(true);
  });

  it("uses a non-identifying fallback distinct id when org_id is absent", () => {
    const calls: Array<{ distinctId: string }> = [];
    const sink = createServerSink({ capture: (p) => calls.push(p) });
    sink(ANALYTICS_EVENTS.AI_GOVERNOR_REJECTED as AnalyticsEventName, {
      outcome: "ceiling",
    } as SafeEventProperties);
    expect(calls[0]!.distinctId).toBe("server");
  });

  it("(d) a throwing client never propagates out of the sink", () => {
    const sink = createServerSink({
      capture: () => {
        throw new Error("provider boom");
      },
    });
    expect(() =>
      sink(ANALYTICS_EVENTS.PAYMENT_RECORDED as AnalyticsEventName, {
        org_id: "o",
      } as SafeEventProperties),
    ).not.toThrow();

    // …and the same via trackEvent (defence in depth) never breaks the caller.
    setAnalyticsSink(sink);
    expect(() => trackEvent(ANALYTICS_EVENTS.PAYMENT_RECORDED, { org_id: "o" })).not.toThrow();
  });
});
