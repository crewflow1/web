import { describe, it, expect, beforeEach, vi } from "vitest";
import Stripe from "stripe";

/**
 * Stripe webhook RECEIVER — signature verification, executed.
 *
 * `contract.test.ts` pins the receiver's behaviour by SOURCE TEXT (it greps the
 * route for `request.text()`, `constructEvent`, the 401/503 literals). That
 * cannot distinguish "verifies the signature" from "contains the string
 * constructEvent", so this file EXECUTES the real `POST` handler against the real
 * Stripe SDK verifier and asserts the actual HTTP outcome:
 *
 *   • a VALID signature  → 200, and the parsed event reaches processStripeEvent,
 *   • a MISSING signature → 401, handler NOT called,
 *   • a FORGED signature  → 401, handler NOT called,
 *   • a STALE signature   → 401 (outside the tolerance window), handler NOT called,
 *   • an unconfigured key / secret → 503 (a half-wired deploy fails loud),
 *   • a handler throw     → 500 (so Stripe retries).
 *
 * Signatures are minted with the SDK's own `generateTestHeaderString`, so the
 * valid/forged/stale distinction is proven by Stripe's genuine HMAC verifier,
 * not a stub. The getStripe() the route calls returns a REAL Stripe instance
 * built with the SAME webhook secret, so verification is end-to-end.
 */

const WEBHOOK_SECRET = "whsec_test_route_secret";

// A real Stripe instance both to MINT signatures in the test and to BACK the
// route's getStripe() mock, so constructEvent runs for real against the secret.
const stripeSdk = new Stripe("sk_test_route_dummy", {
  apiVersion: "2025-02-24.acacia",
});

const h = vi.hoisted(() => ({
  stripe: null as unknown,
  webhookSecret: undefined as string | undefined,
  maintenance: false,
  processCalls: [] as unknown[],
  processThrows: false,
  processResult: {
    status: "processed" as const,
    event_id: "evt_x",
    actions: ["did_a_thing"],
  },
}));

vi.mock("@/lib/stripe/client", () => ({ getStripe: () => h.stripe }));
vi.mock("@/lib/maintenance", () => ({ isMaintenanceMode: () => h.maintenance }));
vi.mock("@/lib/env", () => ({
  env: {
    get STRIPE_WEBHOOK_SECRET() {
      return h.webhookSecret;
    },
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  },
}));
vi.mock("@/server/services/stripe-webhook-handler", () => ({
  processStripeEvent: async (event: unknown) => {
    h.processCalls.push(event);
    if (h.processThrows) throw new Error("handler boom");
    return h.processResult;
  },
}));

const { POST } = await import("@/app/api/webhooks/stripe/route");

const EVENT_BODY = JSON.stringify({
  id: "evt_route_1",
  type: "customer.created",
  data: { object: { id: "cus_1", metadata: { org_id: "org-1" } } },
});

function req(body: string, headers: Record<string, string>): Request {
  return new Request("http://localhost:3000/api/webhooks/stripe", {
    method: "POST",
    headers,
    body,
  });
}

function validHeader(body: string, timestamp?: number): string {
  return stripeSdk.webhooks.generateTestHeaderString({
    payload: body,
    secret: WEBHOOK_SECRET,
    ...(timestamp ? { timestamp } : {}),
  });
}

beforeEach(() => {
  h.stripe = stripeSdk;
  h.webhookSecret = WEBHOOK_SECRET;
  h.maintenance = false;
  h.processCalls.length = 0;
  h.processThrows = false;
});

describe("valid signature", () => {
  it("returns 200 and forwards the parsed event to processStripeEvent", async () => {
    const res = await POST(req(EVENT_BODY, { "stripe-signature": validHeader(EVENT_BODY) }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(true);
    expect(json.event_type).toBe("customer.created");
    expect(json.status).toBe("processed");
    // The handler saw a parsed Stripe.Event, not the raw string.
    expect(h.processCalls).toHaveLength(1);
    expect((h.processCalls[0] as { id: string }).id).toBe("evt_route_1");
  });
});

describe("rejects unverifiable deliveries (handler never runs)", () => {
  it("401 when the Stripe-Signature header is missing", async () => {
    const res = await POST(req(EVENT_BODY, {}));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("missing_stripe_signature");
    expect(h.processCalls).toHaveLength(0);
  });

  it("401 when the signature is FORGED (minted with the wrong secret)", async () => {
    const forged = stripeSdk.webhooks.generateTestHeaderString({
      payload: EVENT_BODY,
      secret: "whsec_the_wrong_secret",
    });
    const res = await POST(req(EVENT_BODY, { "stripe-signature": forged }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("signature_verification_failed");
    expect(h.processCalls).toHaveLength(0);
  });

  it("401 when the body is tampered after signing (signature no longer matches)", async () => {
    const header = validHeader(EVENT_BODY);
    const tampered = EVENT_BODY.replace("org-1", "org-ATTACKER");
    const res = await POST(req(tampered, { "stripe-signature": header }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("signature_verification_failed");
    expect(h.processCalls).toHaveLength(0);
  });

  it("401 when the signature is STALE (timestamp outside the tolerance window)", async () => {
    const ancient = Math.floor(Date.now() / 1000) - 60 * 60; // 1h old ≫ 300s default
    const res = await POST(
      req(EVENT_BODY, { "stripe-signature": validHeader(EVENT_BODY, ancient) }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("signature_verification_failed");
    expect(h.processCalls).toHaveLength(0);
  });
});

describe("configuration gates (half-wired deploy fails loud)", () => {
  it("503 when Stripe is not configured (getStripe returns null)", async () => {
    h.stripe = null;
    const res = await POST(req(EVENT_BODY, { "stripe-signature": validHeader(EVENT_BODY) }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("stripe_not_configured");
    expect(h.processCalls).toHaveLength(0);
  });

  it("503 when the webhook signing secret is absent", async () => {
    h.webhookSecret = undefined;
    const res = await POST(req(EVENT_BODY, { "stripe-signature": validHeader(EVENT_BODY) }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("webhook_secret_not_configured");
    expect(h.processCalls).toHaveLength(0);
  });

  it("503 during a maintenance window, with a retry-after hint (Stripe re-delivers)", async () => {
    h.maintenance = true;
    const res = await POST(req(EVENT_BODY, { "stripe-signature": validHeader(EVENT_BODY) }));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(h.processCalls).toHaveLength(0);
  });
});

describe("handler failure surfaces as a retryable 500", () => {
  it("500 when processStripeEvent throws (Stripe will retry)", async () => {
    h.processThrows = true;
    const res = await POST(req(EVENT_BODY, { "stripe-signature": validHeader(EVENT_BODY) }));
    expect(res.status).toBe(500);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.ok).toBe(false);
    expect(json.event_id).toBe("evt_route_1");
    // The signature DID verify — the handler ran and threw.
    expect(h.processCalls).toHaveLength(1);
  });
});
