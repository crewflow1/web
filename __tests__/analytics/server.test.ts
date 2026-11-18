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

/**
 * Per-request consent cookie as seen by `next/headers`. `undefined` = no cookie;
 * `"throw"` = no request scope at all (cron / webhook / background job).
 */
let cookieValue: string | undefined | "throw" = undefined;
vi.mock("next/headers", () => ({
  cookies: async () => {
    if (cookieValue === "throw") {
      throw new Error("cookies() was called outside a request scope");
    }
    return {
      get: (name: string) =>
        name === "cf_cookie_consent" && cookieValue !== undefined
          ? { name, value: cookieValue }
          : undefined,
    };
  },
}));

const GRANTED = "v2.t1794609958.analytics1.performance0";
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  cookieValue = GRANTED;
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
    await flush();
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
  it("(c) forwards a typed event with the right (sanitised) shape to the client", async () => {
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
    await flush();

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

  it("uses a non-identifying fallback distinct id when org_id is absent", async () => {
    const calls: Array<{ distinctId: string }> = [];
    const sink = createServerSink({ capture: (p) => calls.push(p) });
    sink(ANALYTICS_EVENTS.AI_GOVERNOR_REJECTED as AnalyticsEventName, {
      outcome: "ceiling",
    } as SafeEventProperties);
    await flush();
    expect(calls[0]!.distinctId).toBe("server");
  });

  it("(d) a throwing client never propagates out of the sink", async () => {
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
    await flush();
  });
});

describe("server capture is gated on the request's recorded consent", () => {
  async function emitWith(value: typeof cookieValue): Promise<number> {
    cookieValue = value;
    const calls: unknown[] = [];
    setAnalyticsSink(createServerSink({ capture: (p) => calls.push(p) }));
    trackEvent(ANALYTICS_EVENTS.JOB_CREATED, { org_id: "org_1" });
    await flush();
    return calls.length;
  }

  it("captures when the request carries analytics=granted", async () => {
    expect(await emitWith(GRANTED)).toBe(1);
  });

  it("captures nothing without a consent cookie", async () => {
    expect(await emitWith(undefined)).toBe(0);
  });

  it("captures nothing when analytics is denied (performance-only grant too)", async () => {
    expect(await emitWith("v2.t1794609958.analytics0.performance0")).toBe(0);
    expect(await emitWith("v2.t1794609958.analytics0.performance1")).toBe(0);
  });

  it("captures nothing for a malformed or tampered record (fails closed)", async () => {
    expect(await emitWith("granted-ish")).toBe(0);
    expect(await emitWith("v2.t1794609958.analytics2")).toBe(0);
    expect(await emitWith("")).toBe(0);
  });

  it("captures nothing with no request scope (cron / webhook / background)", async () => {
    expect(await emitWith("throw")).toBe(0);
  });

  it("end-to-end: an ENABLED server sink still drops events without consent", async () => {
    await ensureServerAnalyticsSink({ enabled: "true", key: "phc_x" });
    cookieValue = undefined;
    trackEvent(ANALYTICS_EVENTS.QUOTE_ACCEPTED, { org_id: "o", channel: "portal_token" });
    cookieValue = "v2.t1794609958.analytics0.performance0";
    trackEvent(ANALYTICS_EVENTS.QUOTE_SENT, { org_id: "o" });
    await flush();
    expect(posthogCaptures).toHaveLength(0);
  });
});
