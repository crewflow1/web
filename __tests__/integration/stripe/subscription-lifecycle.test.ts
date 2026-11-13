import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type Stripe from "stripe";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Stripe SUBSCRIPTION LIFECYCLE → org access, proved against real Postgres.
 *
 * The access gate (requireOrgContext → orgHasActiveAccess) authorises ONLY on
 * organizations.status (active/trial). This test drives the real webhook handler with
 * event fixtures for every lifecycle transition the launch audit called out and asserts
 * the resulting org.status — proving the governing invariant:
 *
 *   NEVER incorrectly revoke a customer's PAID entitlement, and ALWAYS revoke once the
 *   subscription has genuinely ended.
 *
 * Covers: paid-through (cancel-at-period-end keeps access), failed payment (past_due →
 * suspended), terminal cancel (subscription.deleted → cancelled — the PR #1080 fix),
 * reactivation, duplicate-webhook idempotency, and refund (must NOT revoke).
 */

type Res<T> = { data: T | null; error: { message: string } | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (c: unknown) => c as unknown as { from(t: string): any };
const svc = () => db(serviceClient());
const TOKEN = `it-sublc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const CUSTOMER = `cus_${TOKEN}`;

describeIntegration("stripe · subscription lifecycle → org access", () => {
  let orgId = "";
  let processStripeEvent: typeof import("@/server/services/stripe-webhook-handler").processStripeEvent;
  const freshId = () => `evt_${TOKEN}_${Math.random().toString(36).slice(2, 10)}`;
  const periodEnd = Math.floor(Date.now() / 1000) + 20 * 86400;

  const subEvent = (
    type: "customer.subscription.updated" | "customer.subscription.created" | "customer.subscription.deleted",
    status: string,
    extra: Record<string, unknown> = {},
  ): Stripe.Event =>
    ({
      id: freshId(),
      type,
      data: {
        object: {
          id: `sub_${TOKEN}`,
          customer: CUSTOMER,
          status,
          current_period_end: periodEnd,
          ...extra,
        },
      },
    }) as unknown as Stripe.Event;

  const refundEvent = (): Stripe.Event =>
    ({
      id: freshId(),
      type: "charge.refunded",
      data: { object: { id: `ch_${TOKEN}`, customer: CUSTOMER, amount_refunded: 50000 } },
    }) as unknown as Stripe.Event;

  async function setStatus(s: string) {
    const r = await svc().from("organizations").update({ status: s }).eq("id", orgId);
    expect(r.error, r.error?.message).toBeNull();
  }
  async function status(): Promise<string> {
    const r = (await svc().from("organizations").select("status").eq("id", orgId).single()) as Res<{ status: string }>;
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.status);
  }

  beforeAll(async () => {
    const org = await svc()
      .from("organizations")
      .insert({ name: "SubLC Org", slug: `${TOKEN}-org`, stripe_customer_id: CUSTOMER })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    orgId = org.data.id as string;
    processStripeEvent = (await import("@/server/services/stripe-webhook-handler")).processStripeEvent;
  });
  afterAll(async () => {
    if (orgId) await svc().from("organizations").delete().eq("id", orgId);
  });
  beforeEach(async () => {
    await setStatus("active");
  });

  it("PAID-THROUGH: cancel-at-period-end keeps the subscription active ⇒ access RETAINED (never revoke paid time)", async () => {
    const r = await processStripeEvent(subEvent("customer.subscription.updated", "active", { cancel_at_period_end: true }));
    expect(r.status).toBe("processed");
    expect(await status(), "a customer who cancelled at period end keeps access until the period ends").toBe("active");
  });

  it("FAILED PAYMENT: past_due ⇒ suspended (access gated while Stripe retries)", async () => {
    await processStripeEvent(subEvent("customer.subscription.updated", "past_due"));
    expect(await status()).toBe("suspended");
  });

  it("TERMINAL CANCEL: subscription.deleted ⇒ cancelled ⇒ access REVOKED (PR #1080)", async () => {
    const r = await processStripeEvent(subEvent("customer.subscription.deleted", "canceled"));
    expect(r.status).toBe("processed");
    expect(await status()).toBe("cancelled");
  });

  it("REACTIVATION: a suspended org returning to active is restored", async () => {
    await setStatus("suspended");
    await processStripeEvent(subEvent("customer.subscription.updated", "active"));
    expect(await status()).toBe("active");
  });

  it("DUPLICATE webhook: the same deleted event twice revokes once, second is a no-op duplicate", async () => {
    const evt = subEvent("customer.subscription.deleted", "canceled");
    const a = await processStripeEvent(evt);
    const b = await processStripeEvent(evt);
    expect([a.status, b.status].sort()).toEqual(["duplicate", "processed"]);
    expect(await status()).toBe("cancelled");
  });

  it("REFUND must NOT revoke access (a refund is not a cancellation)", async () => {
    const r = await processStripeEvent(refundEvent());
    // charge.refunded is not an access-affecting event — unhandled or recorded only.
    expect(await status(), "a refund must never silently revoke an active subscription's access").toBe("active");
    expect(["processed", "skipped"]).toContain(r.status);
  });
});
