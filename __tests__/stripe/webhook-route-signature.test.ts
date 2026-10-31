import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";

/**
 * Stripe webhook ROUTE — behavioural signature-verification + config gating.
 *
 * The existing __tests__/stripe/contract.test.ts asserts the ROUTE SOURCE TEXT
 * (`/missing_stripe_signature/`, `/status: 401/`, …). A source pin cannot tell
 * "returns 401 when the signature is bad" from "the string 401 appears
 * somewhere in the file" — it would stay green if the guard were reordered
 * below the handler dispatch, or if `constructEvent`'s throw were caught and
 * swallowed. Signature verification is the ONLY thing standing between a public
 * internet endpoint and the org-state side effects in processStripeEvent, so it
 * is worth EXECUTING the route's POST against a mocked Stripe SDK.
 *
 * These tests import the real route handler and drive it with real `Request`
 * objects, mocking only `getStripe` (the SDK), `env` (the webhook secret) and
 * `processStripeEvent` (the side-effects layer, exercised separately in
 * lifecycle-transitions.test.ts and webhook-retry.test.ts). No real Stripe call
 * is made — `constructEvent` is a stub we configure per-test.
 */

const h = vi.hoisted(() => {
  const state: {
    stripe: { webhooks: { constructEvent: ReturnType<typeof vi.fn> } } | null;
    webhookSecret: string | undefined;
    maintenance: boolean;
  } = {
    stripe: null,
    webhookSecret: "whsec_test",
    maintenance: false,
  };
  const processStripeEvent = vi.fn(async (event: Stripe.Event) => ({
    status: "processed" as const,
    event_id: event.id,
    actions: [] as string[],
  }));
  return { state, processStripeEvent };
});

vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => h.state.stripe,
}));

vi.mock("@/lib/env", () => ({
  get env() {
    return { STRIPE_WEBHOOK_SECRET: h.state.webhookSecret };
  },
}));

vi.mock("@/lib/maintenance", () => ({
  isMaintenanceMode: () => h.state.maintenance,
}));

vi.mock("@/server/services/stripe-webhook-handler", () => ({
  processStripeEvent: h.processStripeEvent,
}));

const { POST } = await import("@/app/api/webhooks/stripe/route");

const GOOD_EVENT = {
  id: "evt_sig_1",
  type: "invoice.paid",
  created: 1700000000,
  livemode: true,
  data: { object: { id: "in_1" } },
} as unknown as Stripe.Event;

function constructEventStub(result: {
  returns?: Stripe.Event;
  throws?: boolean;
}) {
  return vi.fn(() => {
    if (result.throws) {
      // Mirror what stripe.webhooks.constructEvent throws on a bad signature.
      throw new Error(
        "No signatures found matching the expected signature for payload",
      );
    }
    return result.returns as Stripe.Event;
  });
}

function makeRequest(opts: {
  signature?: string | null;
  body?: string;
}): Request {
  const headers = new Headers();
  if (opts.signature != null) headers.set("stripe-signature", opts.signature);
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers,
    body: opts.body ?? JSON.stringify({ hello: "world" }),
  });
}

beforeEach(() => {
  h.state.stripe = {
    webhooks: { constructEvent: constructEventStub({ returns: GOOD_EVENT }) },
  };
  h.state.webhookSecret = "whsec_test";
  h.state.maintenance = false;
  h.processStripeEvent.mockClear();
});

// =====================================================================
// Config gating
// =====================================================================

describe("config gating returns a retry-safe status, never dispatches", () => {
  it("503 when Stripe is not configured (getStripe null)", async () => {
    h.state.stripe = null;
    const res = await POST(makeRequest({ signature: "sig" }));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: "stripe_not_configured",
    });
    expect(h.processStripeEvent).not.toHaveBeenCalled();
  });

  it("503 when the webhook secret is absent", async () => {
    h.state.webhookSecret = undefined;
    const res = await POST(makeRequest({ signature: "sig" }));
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      error: "webhook_secret_not_configured",
    });
    expect(h.processStripeEvent).not.toHaveBeenCalled();
  });

  it("503 (retry-after) during a maintenance window — provider re-delivers", async () => {
    h.state.maintenance = true;
    const res = await POST(makeRequest({ signature: "sig" }));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("120");
    expect(h.processStripeEvent).not.toHaveBeenCalled();
  });
});

// =====================================================================
// Signature verification — the public-endpoint gate
// =====================================================================

describe("signature verification is mandatory", () => {
  it("401 when the Stripe-Signature header is missing — handler never runs", async () => {
    const res = await POST(makeRequest({ signature: null }));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      error: "missing_stripe_signature",
    });
    // A missing header must short-circuit BEFORE constructEvent + dispatch.
    expect(
      h.state.stripe!.webhooks.constructEvent,
    ).not.toHaveBeenCalled();
    expect(h.processStripeEvent).not.toHaveBeenCalled();
  });

  it("401 when constructEvent rejects the signature — forged body never dispatched", async () => {
    h.state.stripe = {
      webhooks: { constructEvent: constructEventStub({ throws: true }) },
    };
    const res = await POST(
      makeRequest({ signature: "t=1,v1=deadbeef", body: "{\"forged\":true}" }),
    );
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({
      error: "signature_verification_failed",
    });
    // The crux: a bad signature must NOT reach the side-effects layer.
    expect(h.processStripeEvent).not.toHaveBeenCalled();
  });

  it("verifies against the RAW request body (constructEvent gets the exact bytes)", async () => {
    const raw = "{\"id\":\"evt_sig_1\",\"type\":\"invoice.paid\"}";
    await POST(makeRequest({ signature: "t=1,v1=abc", body: raw }));
    const call = h.state.stripe!.webhooks.constructEvent.mock.calls[0]!;
    // arg0 = raw body, arg1 = signature header, arg2 = secret. Signature
    // verification is byte-exact, so a JSON round-trip here would break it.
    expect(call[0]).toBe(raw);
    expect(call[1]).toBe("t=1,v1=abc");
    expect(call[2]).toBe("whsec_test");
  });
});

// =====================================================================
// Valid signature → dispatch
// =====================================================================

describe("a validly-signed event is dispatched to the handler", () => {
  it("200 and forwards the verified event to processStripeEvent", async () => {
    const res = await POST(makeRequest({ signature: "t=1,v1=good" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      event_type: "invoice.paid",
      status: "processed",
      event_id: "evt_sig_1",
    });
    expect(h.processStripeEvent).toHaveBeenCalledTimes(1);
    expect(h.processStripeEvent).toHaveBeenCalledWith(GOOD_EVENT);
  });

  it("500s (so Stripe retries) when the handler throws AFTER verification", async () => {
    h.processStripeEvent.mockRejectedValueOnce(new Error("db unreachable"));
    const res = await POST(makeRequest({ signature: "t=1,v1=good" }));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      event_id: "evt_sig_1",
      error: "db unreachable",
    });
  });
});
