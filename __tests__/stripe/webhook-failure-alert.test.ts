import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A webhook whose handler fails (e.g. a database write returned an error →
 * mustWrite throws) must (1) answer non-2xx so Stripe retries, (2) not claim
 * success, and (3) raise an ALERT — not only a log line.
 */
const h = vi.hoisted(() => ({
  process: vi.fn(),
  capture: vi.fn(),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: h.capture }));
vi.mock("@/lib/maintenance", () => ({ isMaintenanceMode: () => false }));
vi.mock("@/lib/env", () => ({ env: { STRIPE_WEBHOOK_SECRET: "whsec_test_dummy" } }));
vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({
    webhooks: {
      constructEvent: () => ({ id: "evt_1", type: "customer.subscription.deleted", data: { object: {} } }),
    },
  }),
}));
vi.mock("@/server/services/stripe-webhook-handler", () => ({ processStripeEvent: h.process }));

const { POST } = await import("@/app/api/webhooks/stripe/route");

const req = () =>
  new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=x" },
    body: "{}",
  });

beforeEach(() => {
  h.process.mockReset();
  h.capture.mockReset();
});

describe("Stripe webhook — failed database write", () => {
  it("returns 500 (Stripe retries), never ok:true, and alerts Sentry once with the event type", async () => {
    h.process.mockRejectedValue(new Error("organizations revoke update failed: canceling statement due to statement timeout"));
    const res = await POST(req() as never);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; event_id: string };
    expect(body.ok).toBe(false);
    expect(body.event_id).toBe("evt_1");
    expect(h.capture).toHaveBeenCalledTimes(1);
    const [err, ctx] = h.capture.mock.calls[0]!;
    expect(String(err)).toMatch(/statement timeout/);
    expect(ctx.tags).toEqual({ route: "webhooks/stripe", stripe_event_type: "customer.subscription.deleted" });
    expect(ctx.fingerprint).toEqual(["stripe-webhook-handler-failed", "customer.subscription.deleted"]);
  });

  it("a processed event is a 200 with no alert", async () => {
    h.process.mockResolvedValue({ status: "processed", event_id: "evt_1", actions: [] });
    const res = await POST(req() as never);
    expect(res.status).toBe(200);
    expect(h.capture).not.toHaveBeenCalled();
  });
});
