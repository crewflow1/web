import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * BILLING POLICY — a company is activated only once BOTH the £1,000 setup fee and the
 * £500/month subscription have succeeded. Real Postgres, the real webhook handler and the real
 * apply_stripe_subscription_state function (migration 20261352000000); Stripe events are
 * fixtures, and the one Stripe read the handler makes (is the held subscription live?) is a
 * fake. Before the fix, a paid subscription activated a company whose setup fee was unpaid.
 */
const live = vi.hoisted(() => ({ status: new Map<string, string>() }));
vi.mock("@/lib/stripe/client", () => ({
  getStripe: () => ({ subscriptions: { retrieve: async (id: string) => ({ id, status: live.status.get(id) ?? "active" }) } }),
}));
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn(async () => ({ sent: true as const, id: "msg_test" })) }));

type Res<T> = { data: T | null; error: { message: string } | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = () => serviceClient() as unknown as { from(t: string): any };
const TOKEN = `policy-it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const rand = () => Math.random().toString(36).slice(2, 10);

describeIntegration("stripe · activation needs BOTH the setup fee and the subscription", () => {
  const orgIds: string[] = [];
  let processStripeEvent: typeof import("@/server/services/stripe-webhook-handler").processStripeEvent;

  async function mkOrg(status: string, fee: string, sub: string | null = null) {
    const r = (await svc().from("organizations").insert({
      name: `Policy IT ${rand()}`, slug: `${TOKEN}-${rand()}`, status, setup_fee_status: fee,
      stripe_customer_id: `cus_${TOKEN}_${rand()}`, stripe_subscription_id: sub,
    }).select("id, stripe_customer_id").single()) as Res<{ id: string; stripe_customer_id: string }>;
    expect(r.error, r.error?.message).toBeNull();
    orgIds.push(r.data!.id);
    return { id: r.data!.id, customer: r.data!.stripe_customer_id };
  }
  const org = async (id: string) =>
    ((await svc().from("organizations").select("status, setup_fee_status, stripe_subscription_id").eq("id", id).single()) as Res<{ status: string; setup_fee_status: string; stripe_subscription_id: string | null }>).data!;
  const subCheckout = (orgId: string, customer: string, sub: string, id = `evt_${TOKEN}_${rand()}`) => ({
    id, type: "checkout.session.completed",
    data: { object: { id: `cs_${TOKEN}_${rand()}`, customer, subscription: sub, payment_status: "paid", metadata: { org_id: orgId, kind: "subscription" } } },
  }) as unknown as Stripe.Event;
  const feeCheckout = (orgId: string, customer: string) => ({
    id: `evt_${TOKEN}_${rand()}`, type: "checkout.session.completed",
    data: { object: { id: `cs_${TOKEN}_${rand()}`, customer, payment_intent: `pi_${TOKEN}_${rand()}`, amount_total: 100_000, currency: "gbp", payment_status: "paid", metadata: { org_id: orgId, kind: "setup_fee" } } },
  }) as unknown as Stripe.Event;
  const subUpdated = (customer: string, sub: string, status: string) => ({
    id: `evt_${TOKEN}_${rand()}`, type: "customer.subscription.updated",
    data: { object: { id: sub, customer, status, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400 } },
  }) as unknown as Stripe.Event;
  const heldNotices = async (orgId: string) =>
    (((await svc().from("notifications").select("id").eq("org_id", orgId).eq("type", "stripe.activation_held_setup_fee")) as Res<unknown[]>).data ?? []).length;

  beforeAll(async () => {
    ({ processStripeEvent } = await import("@/server/services/stripe-webhook-handler"));
  });
  afterAll(async () => {
    for (const id of orgIds) await svc().from("organizations").delete().eq("id", id);
  });

  it("subscription paid FIRST: the company is NOT activated; HQ is told; the setup fee then activates it", async () => {
    const o = await mkOrg("trial", "pending");
    const sub = `sub_${TOKEN}_${rand()}`;
    await processStripeEvent(subCheckout(o.id, o.customer, sub));
    expect(await org(o.id)).toMatchObject({ status: "trial", setup_fee_status: "pending", stripe_subscription_id: sub });
    expect(await heldNotices(o.id), "HQ alerted once").toBe(1);

    await processStripeEvent(feeCheckout(o.id, o.customer));
    expect(await org(o.id)).toMatchObject({ status: "active", setup_fee_status: "paid" });
  });

  it("the normal order (setup fee, then subscription) activates on the subscription", async () => {
    const o = await mkOrg("trial", "pending");
    await processStripeEvent(feeCheckout(o.id, o.customer));
    expect(await org(o.id)).toMatchObject({ status: "trial", setup_fee_status: "paid" });
    await processStripeEvent(subCheckout(o.id, o.customer, `sub_${TOKEN}_${rand()}`));
    expect((await org(o.id)).status).toBe("active");
    expect(await heldNotices(o.id)).toBe(0);
  });

  it("a setup fee waived by HQ counts as satisfied", async () => {
    const o = await mkOrg("trial", "waived");
    await processStripeEvent(subCheckout(o.id, o.customer, `sub_${TOKEN}_${rand()}`));
    expect((await org(o.id)).status).toBe("active");
  });

  it("subscription.updated(active) on a never-active company with the fee unpaid is held too", async () => {
    const sub = `sub_${TOKEN}_${rand()}`;
    const o = await mkOrg("pending", "pending", sub);
    await processStripeEvent(subUpdated(o.customer, sub, "active"));
    expect((await org(o.id)).status).toBe("pending");
  });

  it("the setup fee arriving while the held subscription is NOT live (past_due) does not activate", async () => {
    const o = await mkOrg("trial", "pending");
    const sub = `sub_${TOKEN}_${rand()}`;
    await processStripeEvent(subCheckout(o.id, o.customer, sub));
    live.status.set(sub, "past_due");
    await processStripeEvent(feeCheckout(o.id, o.customer));
    expect(await org(o.id)).toMatchObject({ status: "trial", setup_fee_status: "paid" });
  });

  it("never demotes and never blocks recovery: an active company stays active; a suspended one recovers", async () => {
    const subA = `sub_${TOKEN}_${rand()}`;
    const a = await mkOrg("active", "pending", subA); // e.g. provisioned before the policy
    await processStripeEvent(subUpdated(a.customer, subA, "active"));
    expect((await org(a.id)).status).toBe("active");
    const subS = `sub_${TOKEN}_${rand()}`;
    const s = await mkOrg("suspended", "pending", subS);
    await processStripeEvent(subUpdated(s.customer, subS, "active"));
    expect((await org(s.id)).status, "payment recovery restores access").toBe("active");
  });

  it("an event about a company that no longer exists is stored and processed, not retried forever", async () => {
    const gone = crypto.randomUUID();
    const evt = subCheckout(gone, `cus_${TOKEN}_${rand()}`, `sub_${TOKEN}_${rand()}`);
    await expect(processStripeEvent(evt)).resolves.toMatchObject({ event_id: evt.id });
    const row = ((await svc().from("billing_events").select("org_id, processed_at, error_message").eq("event_id", evt.id).single()) as Res<{ org_id: string | null; processed_at: string | null; error_message: string | null }>).data!;
    expect(row).toMatchObject({ org_id: null, error_message: null });
    expect(row.processed_at).not.toBeNull();
  });

  it("a duplicate delivery of the held event changes nothing and does not alert HQ twice", async () => {
    const o = await mkOrg("trial", "pending");
    const sub = `sub_${TOKEN}_${rand()}`;
    const evt = subCheckout(o.id, o.customer, sub, `evt_${TOKEN}_dup_${rand()}`);
    await processStripeEvent(evt);
    await processStripeEvent(evt);
    expect((await org(o.id)).status).toBe("trial");
    expect(await heldNotices(o.id)).toBe(1);
  });
});
