import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * SUBSCRIPTION CANCELLATION → entitlement state, proved against REAL Postgres.
 *
 * EVIDENCE LABELS
 *   • Everything about organizations.status, the cancellation ledger, the three
 *     SQL functions, the webhook handler's writes, grants and RLS is REAL: real
 *     migrations (20261316000000 / 20261317000000), real rows, real concurrency
 *     (Promise.all against one database).
 *   • STRIPE IS SIMULATED-ONLY. Webhook events are fixtures passed straight to
 *     processStripeEvent (as the existing lifecycle test does), and where the
 *     owner action is driven end to end the Stripe client is a fake. No Stripe
 *     API is called.
 *
 * The governing invariants:
 *   1. Access is revoked EXACTLY ONCE per cancelled subscription, whichever of
 *      the owner action and the webhook confirms first — and however many times
 *      either is repeated or raced.
 *   2. A cancelled subscription NEVER grants access again: a late or
 *      out-of-order subscription.updated / checkout.session.completed /
 *      invoice.* cannot flip the org back.
 *   3. A NEW subscription (reactivation) DOES grant access, and a late event for
 *      the old one cannot take it away.
 *   4. Cancelling destroys no accounting record.
 */

// The owner's confirmation email goes through the email abstraction; spy on it
// so nothing is sent and so "sent once" is assertable.
const email = vi.hoisted(() => ({ sendEmail: vi.fn(async () => ({ sent: true as const, id: "msg_test" })) }));
vi.mock("@/lib/email/send", () => ({ sendEmail: email.sendEmail }));

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = (c: unknown) => c as unknown as { from(t: string): any; rpc(fn: string, args?: unknown): any };
const svc = () => db(serviceClient());

const TOKEN = `cancel-it-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const rand = () => Math.random().toString(36).slice(2, 10);
const evtId = () => `evt_${TOKEN}_${rand()}`;

type Mods = {
  processStripeEvent: typeof import("@/server/services/stripe-webhook-handler").processStripeEvent;
  svcMod: typeof import("@/server/services/subscription-cancellation");
  history: typeof import("@/server/services/billing-history");
};

describeIntegration("stripe · subscription cancellation → entitlement state", () => {
  const orgIds: string[] = [];
  const userIds: string[] = [];
  let m: Mods;
  let owner = { id: "", email: "", password: "" };

  // ── fixtures ──────────────────────────────────────────────────────────────
  async function mkOrg(
    status: string,
    link: { customer?: string | null; sub?: string | null } = {},
  ): Promise<{ id: string; customer: string | null; sub: string | null }> {
    const customer = link.customer === undefined ? `cus_${TOKEN}_${rand()}` : link.customer;
    const sub = link.sub === undefined ? `sub_${TOKEN}_${rand()}` : link.sub;
    const r = (await svc()
      .from("organizations")
      .insert({
        name: `Cancel IT ${rand()}`,
        slug: `${TOKEN}-${rand()}`,
        status,
        stripe_customer_id: customer,
        stripe_subscription_id: sub,
      })
      .select("id")
      .single()) as Res<{ id: string }>;
    expect(r.error, r.error?.message).toBeNull();
    const id = r.data!.id;
    orgIds.push(id);
    return { id, customer, sub };
  }

  async function org(id: string) {
    const r = (await svc()
      .from("organizations")
      .select("status, cancelled_at, stripe_subscription_id, next_renewal_at")
      .eq("id", id)
      .single()) as Res<{
      status: string;
      cancelled_at: string | null;
      stripe_subscription_id: string | null;
      next_renewal_at: string | null;
    }>;
    expect(r.error, r.error?.message).toBeNull();
    return r.data!;
  }
  const status = async (id: string) => (await org(id)).status;

  async function ledger(orgId: string) {
    const r = (await svc()
      .from("subscription_cancellations")
      .select(
        "id, stripe_subscription_id, state, source, confirmed_via, access_revoked, refund_review, requested_by, requested_by_email, reason, last_error, details",
      )
      .eq("org_id", orgId)
      .order("created_at", { ascending: true })) as Res<Array<Record<string, unknown>>>;
    expect(r.error, r.error?.message).toBeNull();
    return r.data ?? [];
  }

  async function notices(orgId: string) {
    const r = (await svc()
      .from("notifications")
      .select("audience, type, title")
      .eq("org_id", orgId)) as Res<Array<{ audience: string; type: string; title: string }>>;
    expect(r.error, r.error?.message).toBeNull();
    return r.data ?? [];
  }

  async function audit(orgId: string, action: string) {
    const r = (await svc()
      .from("admin_activity_log")
      .select("action, actor_id, actor_email, metadata")
      .eq("target_table", "organizations")
      .eq("target_id", orgId)
      .eq("action", action)) as Res<Array<{ actor_id: string | null; actor_email: string | null; metadata: Record<string, unknown> }>>;
    expect(r.error, r.error?.message).toBeNull();
    return r.data ?? [];
  }

  // ── SQL function wrappers (service role) ──────────────────────────────────
  async function claim(orgId: string, sub: string | null, lease?: number) {
    const r = (await svc().rpc("claim_subscription_cancellation", {
      p_org_id: orgId,
      p_subscription_id: sub,
      p_user_id: owner.id,
      p_user_email: owner.email,
      p_reason: "it test",
      ...(lease === undefined ? {} : { p_lease_seconds: lease }),
    })) as Res<Array<{ outcome: string; cancellation_id: string | null }>>;
    expect(r.error, r.error?.message).toBeNull();
    return r.data![0]!;
  }
  async function confirm(
    orgId: string,
    sub: string | null,
    via: "action" | "webhook",
    extra: { cancellationId?: string | null; force?: boolean; refund?: string } = {},
  ) {
    const r = (await svc().rpc("confirm_subscription_cancellation", {
      p_org_id: orgId,
      p_subscription_id: sub,
      p_via: via,
      p_details: { test: true },
      p_cancellation_id: extra.cancellationId ?? null,
      p_force_revoke: extra.force === true,
      p_refund_review: extra.refund ?? null,
    })) as Res<Array<{ newly_confirmed: boolean; access_revoked: boolean; cancellation_id: string; source: string }>>;
    expect(r.error, r.error?.message).toBeNull();
    return r.data![0]!;
  }
  async function apply(orgId: string, sub: string, orgStatus: string | null) {
    const r = (await svc().rpc("apply_stripe_subscription_state", {
      p_org_id: orgId,
      p_subscription_id: sub,
      p_customer_id: null,
      p_org_status: orgStatus,
      p_next_renewal_at: null,
    })) as Res<string>;
    expect(r.error, r.error?.message).toBeNull();
    return r.data;
  }

  // ── Stripe event fixtures ─────────────────────────────────────────────────
  const periodEnd = Math.floor(Date.now() / 1000) + 20 * 86400;
  const subEvent = (
    type: "customer.subscription.updated" | "customer.subscription.created" | "customer.subscription.deleted",
    customer: string,
    sub: string,
    st: string,
    id = evtId(),
  ): Stripe.Event =>
    ({
      id,
      type,
      data: { object: { id: sub, customer, status: st, current_period_end: periodEnd } },
    }) as unknown as Stripe.Event;
  const invoiceEvent = (
    type: "invoice.payment_failed" | "invoice.paid",
    customer: string,
    sub: string,
    amount = 50_000,
  ): Stripe.Event =>
    ({
      id: evtId(),
      type,
      data: {
        object: {
          id: `in_${TOKEN}_${rand()}`,
          customer,
          subscription: sub,
          amount_due: amount,
          amount_paid: type === "invoice.paid" ? amount : 0,
          currency: "gbp",
        },
      },
    }) as unknown as Stripe.Event;
  const checkoutEvent = (orgId: string, customer: string, sub: string): Stripe.Event =>
    ({
      id: evtId(),
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_${TOKEN}_${rand()}`,
          customer,
          subscription: sub,
          payment_status: "paid",
          metadata: { org_id: orgId, kind: "subscription" },
        },
      },
    }) as unknown as Stripe.Event;

  // ── a fake Stripe for the end-to-end owner action ─────────────────────────
  type Snap = import("@/server/services/subscription-cancellation").SubscriptionSnapshot;
  function fakeStripe(customer: string, subs: Array<{ id: string; status: string }>, opts: { delayMs?: number; fail?: unknown } = {}) {
    const state = new Map(subs.map((s) => [s.id, s.status]));
    const calls = { cancel: [] as string[] };
    const now = Math.floor(Date.now() / 1000);
    const snap = (id: string): Snap => ({
      id,
      status: state.get(id)!,
      customerId: customer,
      metadataOrgId: null,
      currentPeriodStart: now - 10 * 86400,
      currentPeriodEnd: now + 20 * 86400,
      unitAmountMinor: 50_000,
      quantity: 1,
      currency: "gbp",
      shape: {
        id,
        status: state.get(id)!,
        customer,
        current_period_start: now - 10 * 86400,
        current_period_end: now + 20 * 86400,
      },
    });
    return {
      calls,
      state,
      api: {
        listCustomerSubscriptions: async () =>
          [...state.keys()].filter((id) => state.get(id) !== "canceled").map(snap),
        retrieveSubscription: async (id: string) => (state.has(id) ? snap(id) : null),
        cancelSubscription: async (id: string) => {
          calls.cancel.push(id);
          if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
          if (opts.fail) throw opts.fail;
          state.set(id, "canceled");
          return snap(id);
        },
        stopInvoiceCollection: async () => ({ stopped: [], failed: [] }),
        countPendingInvoiceItems: async () => 0,
      },
    };
  }
  function depsWith(stripe: ReturnType<typeof fakeStripe>) {
    return {
      ...m.svcMod.wireCancellationDeps(),
      isDisabled: () => false,
      stripeAvailable: () => true,
      stripe: stripe.api,
    };
  }
  const actor = () => ({ userId: owner.id, email: owner.email });

  beforeAll(async () => {
    const password = `Pw-${TOKEN}-${rand()}`;
    const mail = `${TOKEN}-owner@example.test`;
    const created = await serviceClient().auth.admin.createUser({ email: mail, password, email_confirm: true });
    expect(created.error, created.error?.message).toBeNull();
    owner = { id: created.data.user!.id, email: mail, password };
    userIds.push(owner.id);
    const u = await svc().from("users").insert({ id: owner.id, email: mail, full_name: "Cancel IT Owner" });
    expect(u.error, u.error?.message).toBeNull();

    m = {
      processStripeEvent: (await import("@/server/services/stripe-webhook-handler")).processStripeEvent,
      svcMod: await import("@/server/services/subscription-cancellation"),
      history: await import("@/server/services/billing-history"),
    };
  });

  afterAll(async () => {
    for (const id of orgIds) await svc().from("organizations").delete().eq("id", id);
    await svc().from("billing_events").delete().like("event_id", `evt_${TOKEN}_%`);
    for (const id of userIds) {
      await svc().from("users").delete().eq("id", id);
      await serviceClient().auth.admin.deleteUser(id);
    }
  });

  beforeEach(() => {
    email.sendEmail.mockClear();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 1. The SQL functions
  // ══════════════════════════════════════════════════════════════════════════

  it("CLAIM: first caller claims, second is in_flight, a confirmed id is already_confirmed", async () => {
    const o = await mkOrg("active");
    expect((await claim(o.id, o.sub)).outcome).toBe("claimed");
    expect((await claim(o.id, o.sub)).outcome).toBe("in_flight");
    await confirm(o.id, o.sub, "action");
    expect((await claim(o.id, o.sub)).outcome).toBe("already_confirmed");
    expect(await ledger(o.id)).toHaveLength(1);
  });

  it("CLAIM: 8 simultaneous claims → exactly one 'claimed', one ledger row", async () => {
    const o = await mkOrg("active");
    const results = await Promise.all(Array.from({ length: 8 }, () => claim(o.id, o.sub)));
    expect(results.filter((r) => r.outcome === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "in_flight")).toHaveLength(7);
    expect(await ledger(o.id)).toHaveLength(1);
  });

  it("CLAIM: a FAILED claim, and one past its lease, can be retaken (no permanent lock-out)", async () => {
    const o = await mkOrg("active");
    const first = await claim(o.id, o.sub);
    await svc().from("subscription_cancellations").update({ state: "failed", last_error: "x" }).eq("id", first.cancellation_id);
    const second = await claim(o.id, o.sub);
    expect(second).toEqual({ outcome: "claimed", cancellation_id: first.cancellation_id });
    // Orphaned in-flight claim (the action's process died): past the lease.
    await svc()
      .from("subscription_cancellations")
      .update({ claimed_at: new Date(Date.now() - 10 * 60_000).toISOString() })
      .eq("id", first.cancellation_id);
    expect((await claim(o.id, o.sub)).outcome).toBe("claimed");
    const [row] = await ledger(o.id);
    expect(row!.last_error).toBeNull();
  });

  it("CONFIRM: 6 simultaneous confirms (action + webhook mixed) → revoked EXACTLY once", async () => {
    const o = await mkOrg("active");
    await claim(o.id, o.sub);
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => confirm(o.id, o.sub, i % 2 ? "webhook" : "action")),
    );
    expect(results.filter((r) => r.newly_confirmed)).toHaveLength(1);
    expect(results.filter((r) => r.access_revoked)).toHaveLength(1);
    const after = await org(o.id);
    expect(after.status).toBe("cancelled");
    expect(after.cancelled_at).not.toBeNull();
    expect(after.next_renewal_at).toBeNull();
    expect(await ledger(o.id)).toHaveLength(1);
  });

  it("CONFIRM: action then webhook → the webhook is a no-op", async () => {
    const o = await mkOrg("active");
    await claim(o.id, o.sub);
    const a = await confirm(o.id, o.sub, "action", { refund: "pending" });
    const stamped = (await org(o.id)).cancelled_at;
    const b = await confirm(o.id, o.sub, "webhook");
    expect([a.newly_confirmed, a.access_revoked]).toEqual([true, true]);
    expect([b.newly_confirmed, b.access_revoked]).toEqual([false, false]);
    expect((await org(o.id)).cancelled_at).toBe(stamped); // not re-stamped
    const [row] = await ledger(o.id);
    expect(row).toMatchObject({ state: "confirmed", confirmed_via: "action", source: "owner", refund_review: "pending" });
  });

  it("CONFIRM: webhook then action → the action is a no-op for revocation, but its refund review lands on the ledger", async () => {
    const o = await mkOrg("active");
    await claim(o.id, o.sub);
    const a = await confirm(o.id, o.sub, "webhook");
    const b = await confirm(o.id, o.sub, "action", { force: true, refund: "pending" });
    expect([a.newly_confirmed, a.access_revoked]).toEqual([true, true]);
    expect([b.newly_confirmed, b.access_revoked]).toEqual([false, false]);
    const [row] = await ledger(o.id);
    expect(row).toMatchObject({ confirmed_via: "webhook", refund_review: "pending", access_revoked: true });
  });

  it("CONFIRM (webhook, no prior claim): Stripe-initiated cancel writes its own tombstone", async () => {
    const o = await mkOrg("suspended");
    const r = await confirm(o.id, o.sub, "webhook");
    expect([r.newly_confirmed, r.access_revoked, r.source]).toEqual([true, true, "stripe_webhook"]);
    expect(await status(o.id)).toBe("cancelled");
  });

  it("NO FLAP BACK: once tombstoned, apply_stripe_subscription_state writes nothing", async () => {
    const o = await mkOrg("active");
    await confirm(o.id, o.sub, "webhook");
    expect(await apply(o.id, o.sub!, "active")).toBe("ignored_cancelled_subscription");
    expect(await apply(o.id, o.sub!, "suspended")).toBe("ignored_cancelled_subscription");
    expect(await status(o.id)).toBe("cancelled");
  });

  it("REACTIVATION: a NEW subscription id applies → active, cancelled_at cleared", async () => {
    const o = await mkOrg("active");
    await confirm(o.id, o.sub, "webhook");
    const fresh = `sub_${TOKEN}_new_${rand()}`;
    expect(await apply(o.id, fresh, "active")).toBe("applied");
    const after = await org(o.id);
    expect(after.status).toBe("active");
    expect(after.cancelled_at).toBeNull();
    expect(after.stripe_subscription_id).toBe(fresh);
  });

  it("STALE EVENT after reactivation: a late 'deleted' for the OLD id tombstones it but leaves the NEW access alone", async () => {
    const old = `sub_${TOKEN}_old_${rand()}`;
    const o = await mkOrg("active", { sub: `sub_${TOKEN}_current_${rand()}` });
    const r = await confirm(o.id, old, "webhook");
    expect([r.newly_confirmed, r.access_revoked]).toEqual([true, false]);
    expect(await status(o.id)).toBe("active");
    // …whereas the owner action, having cancelled everything, forces it.
    const forced = await confirm(o.id, `sub_${TOKEN}_x_${rand()}`, "action", { force: true });
    expect(forced.access_revoked).toBe(true);
    expect(await status(o.id)).toBe("cancelled");
  });

  it("HQ reactivates by hand, then the dead subscription's event is redelivered → NOT re-cancelled", async () => {
    const o = await mkOrg("active");
    await confirm(o.id, o.sub, "webhook");
    await svc().from("organizations").update({ status: "active", cancelled_at: null }).eq("id", o.id);
    const again = await confirm(o.id, o.sub, "webhook");
    expect([again.newly_confirmed, again.access_revoked]).toEqual([false, false]);
    expect(await status(o.id)).toBe("active");
  });

  it("LOCAL-ONLY (no Stripe subscription): cancel, reactivate, cancel again — each its own row", async () => {
    const o = await mkOrg("trial", { customer: null, sub: null });
    const c1 = await claim(o.id, null);
    expect(c1.outcome).toBe("claimed");
    expect((await claim(o.id, null)).outcome).toBe("in_flight");
    const r1 = await confirm(o.id, null, "action", { cancellationId: c1.cancellation_id, force: true });
    expect([r1.newly_confirmed, r1.access_revoked]).toEqual([true, true]);
    expect((await claim(o.id, null)).outcome).toBe("already_confirmed");

    await svc().from("organizations").update({ status: "active" }).eq("id", o.id);
    const c2 = await claim(o.id, null);
    expect(c2.outcome).toBe("claimed");
    expect(c2.cancellation_id).not.toBe(c1.cancellation_id);
    await confirm(o.id, null, "action", { cancellationId: c2.cancellation_id, force: true });
    expect(await status(o.id)).toBe("cancelled");
    expect(await ledger(o.id)).toHaveLength(2);
  });

  it("confirm for an org that does not exist raises (never a silent success)", async () => {
    const r = (await svc().rpc("confirm_subscription_cancellation", {
      p_org_id: "00000000-0000-4000-8000-000000000000",
      p_subscription_id: "sub_none",
      p_via: "webhook",
    })) as Res<unknown>;
    expect(r.error).not.toBeNull();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 2. Grants / RLS — the ledger and the functions are service-role only
  // ══════════════════════════════════════════════════════════════════════════

  it("ANON and an AUTHENTICATED user can neither read the ledger nor execute the functions", async () => {
    const o = await mkOrg("active");
    await claim(o.id, o.sub);
    await svc().from("memberships").insert({ org_id: o.id, user_id: owner.id, role: "owner" });

    const signIn = await createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    }).auth.signInWithPassword({ email: owner.email, password: owner.password });
    expect(signIn.error, signIn.error?.message).toBeNull();
    const asOwner = db(userClient(signIn.data.session!.access_token));

    for (const [who, client] of [
      ["anon", db(anonClient())],
      ["authenticated owner", asOwner],
    ] as const) {
      const read = (await client.from("subscription_cancellations").select("id").eq("org_id", o.id)) as Res<unknown[]>;
      expect(read.error === null && (read.data?.length ?? 0) > 0, `${who} read the ledger`).toBe(false);

      for (const [fn, args] of [
        ["claim_subscription_cancellation", { p_org_id: o.id, p_subscription_id: "sub_x", p_user_id: owner.id, p_user_email: "x", p_reason: null }],
        ["confirm_subscription_cancellation", { p_org_id: o.id, p_subscription_id: o.sub, p_via: "webhook" }],
        ["apply_stripe_subscription_state", { p_org_id: o.id, p_subscription_id: "sub_y", p_customer_id: null, p_org_status: "active", p_next_renewal_at: null }],
      ] as const) {
        const r = (await client.rpc(fn, args)) as Res<unknown>;
        expect(r.error, `${who} executed ${fn}`).not.toBeNull();
      }
    }
    // Nothing they attempted changed anything.
    expect(await status(o.id)).toBe("active");
    expect((await ledger(o.id)).map((r) => r.state)).toEqual(["requested"]);

    // …and the owner of a CANCELLED org still reads their own org's data under
    // RLS (the export depends on it): membership, not org status, is the gate.
    await confirm(o.id, o.sub, "action");
    const own = (await asOwner.from("organizations").select("id, status").eq("id", o.id)) as Res<Array<{ status: string }>>;
    expect(own.error, own.error?.message).toBeNull();
    expect(own.data).toEqual([{ id: o.id, status: "cancelled" }]);
    const customers = (await asOwner.from("customers").select("id").eq("org_id", o.id).limit(1)) as Res<unknown[]>;
    expect(customers.error, customers.error?.message).toBeNull();
    // …but not another org's.
    const other = await mkOrg("active");
    const foreign = (await asOwner.from("organizations").select("id").eq("id", other.id)) as Res<unknown[]>;
    expect(foreign.data ?? []).toEqual([]);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 3. The webhook handler — duplicates, late and out-of-order events
  // ══════════════════════════════════════════════════════════════════════════

  it("DUPLICATE customer.subscription.deleted (same event, and a second event id) → one revoke, one HQ alert", async () => {
    const o = await mkOrg("active");
    const evt = subEvent("customer.subscription.deleted", o.customer!, o.sub!, "canceled");
    const a = await m.processStripeEvent(evt);
    const b = await m.processStripeEvent(evt);
    const c = await m.processStripeEvent(subEvent("customer.subscription.deleted", o.customer!, o.sub!, "canceled"));
    expect([a.status, b.status]).toEqual(["processed", "duplicate"]);
    expect(c).toMatchObject({ status: "processed", actions: ["subscription_deleted:already_confirmed"] });
    expect(await status(o.id)).toBe("cancelled");
    expect((await notices(o.id)).filter((n) => n.type === "stripe.subscription_cancelled")).toHaveLength(1);
    expect(await ledger(o.id)).toHaveLength(1);
  });

  it("LATE customer.subscription.updated (active, then past_due) after cancellation → org stays cancelled; ignored + audited", async () => {
    const o = await mkOrg("active");
    await m.processStripeEvent(subEvent("customer.subscription.deleted", o.customer!, o.sub!, "canceled"));
    const late = await m.processStripeEvent(subEvent("customer.subscription.updated", o.customer!, o.sub!, "active"));
    expect(late).toMatchObject({
      status: "processed",
      actions: ["subscription_ignored:ignored_cancelled_subscription:active"],
    });
    expect(await status(o.id)).toBe("cancelled");
    await m.processStripeEvent(subEvent("customer.subscription.updated", o.customer!, o.sub!, "past_due"));
    await m.processStripeEvent(subEvent("customer.subscription.created", o.customer!, o.sub!, "trialing"));
    expect(await status(o.id), "must not flap to suspended or active").toBe("cancelled");
    expect((await audit(o.id, "stripe.subscription_upsert_ignored")).length).toBe(3);
    // The org_subscriptions projection is not rewritten to 'active' either.
    const proj = (await svc().from("org_subscriptions").select("status").eq("org_id", o.id).maybeSingle()) as Res<{ status: string }>;
    expect(proj.data?.status).toBe("canceled");
  });

  it("OUT OF ORDER: 'updated → canceled' (no deleted event) is terminal and revokes", async () => {
    const o = await mkOrg("active");
    const r = await m.processStripeEvent(subEvent("customer.subscription.updated", o.customer!, o.sub!, "canceled"));
    expect(r).toMatchObject({ status: "processed", actions: ["subscription_deleted:org_cancelled"] });
    expect(await status(o.id)).toBe("cancelled");
  });

  it("LATE invoice.payment_failed after cancellation → accounting row + HQ alert, but NO 'fix your card' notice to the customer; status untouched", async () => {
    const o = await mkOrg("suspended");
    await m.processStripeEvent(subEvent("customer.subscription.deleted", o.customer!, o.sub!, "canceled"));
    const r = await m.processStripeEvent(invoiceEvent("invoice.payment_failed", o.customer!, o.sub!));
    expect(r.status).toBe("processed");
    expect((r as { actions: string[] }).actions[0]).toMatch(/^invoice_failed_after_cancellation:/);
    expect(await status(o.id)).toBe("cancelled");
    const n = (await notices(o.id)).filter((x) => x.type === "stripe.payment_failed");
    expect(n.map((x) => x.audience)).toEqual(["hq"]);
    const inv = (await svc().from("billing_invoices").select("status").eq("org_id", o.id)) as Res<Array<{ status: string }>>;
    expect(inv.data).toEqual([{ status: "failed" }]);
  });

  it("CONTROL: invoice.payment_failed for a LIVE subscription still notifies the customer", async () => {
    const o = await mkOrg("active");
    await m.processStripeEvent(invoiceEvent("invoice.payment_failed", o.customer!, o.sub!));
    const n = (await notices(o.id)).filter((x) => x.type === "stripe.payment_failed");
    expect(n.map((x) => x.audience).sort()).toEqual(["customer", "hq"]);
  });

  it("LATE invoice.paid after cancellation → recorded; the org is NOT reactivated", async () => {
    const o = await mkOrg("active");
    await m.processStripeEvent(subEvent("customer.subscription.deleted", o.customer!, o.sub!, "canceled"));
    const r = await m.processStripeEvent(invoiceEvent("invoice.paid", o.customer!, o.sub!));
    expect(r.status).toBe("processed");
    expect(await status(o.id)).toBe("cancelled");
    const inv = (await svc().from("billing_invoices").select("status, kind").eq("org_id", o.id)) as Res<Array<{ status: string; kind: string }>>;
    expect(inv.data).toEqual([{ status: "paid", kind: "subscription" }]);
  });

  it("CANCEL JUST AFTER SIGNUP: checkout.session.completed delivered after the cancel does not re-activate; a NEW subscription's checkout does", async () => {
    const o = await mkOrg("active");
    await m.processStripeEvent(subEvent("customer.subscription.deleted", o.customer!, o.sub!, "canceled"));
    const late = await m.processStripeEvent(checkoutEvent(o.id, o.customer!, o.sub!));
    expect((late as { actions: string[] }).actions).toContain(`subscription_start_ignored:cancelled:${o.sub}`);
    expect(await status(o.id)).toBe("cancelled");

    const fresh = `sub_${TOKEN}_react_${rand()}`;
    const react = await m.processStripeEvent(checkoutEvent(o.id, o.customer!, fresh));
    expect((react as { actions: string[] }).actions).toContain(`subscription_started:${fresh}`);
    expect(await status(o.id)).toBe("active");

    // A late 'deleted' redelivery for the OLD subscription cannot take the
    // reactivated access away.
    await m.processStripeEvent(subEvent("customer.subscription.deleted", o.customer!, o.sub!, "canceled"));
    expect(await status(o.id)).toBe("active");
  });

  it("ACCOUNTING PRESERVED: cancelling deletes/rewrites no billing_events or billing_invoices row", async () => {
    const o = await mkOrg("active");
    await m.processStripeEvent(invoiceEvent("invoice.paid", o.customer!, o.sub!, 50_000));
    await m.processStripeEvent(invoiceEvent("invoice.paid", o.customer!, o.sub!, 50_000));
    const snapshot = async () => {
      const inv = (await svc().from("billing_invoices").select("id, status, amount_gbp, stripe_invoice_id, updated_at").eq("org_id", o.id).order("id")) as Res<unknown[]>;
      const ev = (await svc().from("billing_events").select("event_id, event_type, processed_at").eq("org_id", o.id).order("event_id")) as Res<unknown[]>;
      return { inv: inv.data, ev: ev.data };
    };
    const before = await snapshot();
    expect(before.inv).toHaveLength(2);

    const stripe = fakeStripe(o.customer!, [{ id: o.sub!, status: "active" }]);
    const r = await m.svcMod.cancelOrgSubscription(depsWith(stripe), { orgId: o.id, actor: actor() });
    expect(r.ok).toBe(true);
    await m.processStripeEvent(subEvent("customer.subscription.deleted", o.customer!, o.sub!, "canceled"));

    const after = await snapshot();
    expect(after.inv).toEqual(before.inv);
    // Every earlier event is still there, unchanged; only the new one was added.
    expect(after.ev).toEqual(expect.arrayContaining(before.ev as unknown[]));
    expect(after.ev!.length).toBe(before.ev!.length + 1);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 4. The owner action end to end (real ledger / audit / notifications, fake Stripe)
  // ══════════════════════════════════════════════════════════════════════════

  it("ACTIVE org: cancel → revoked, ledger confirmed via action, refund review pending, audited with the actor, HQ alerted, owner emailed once; the webhook that follows is a no-op", async () => {
    const o = await mkOrg("active");
    const stripe = fakeStripe(o.customer!, [{ id: o.sub!, status: "active" }]);
    const r = await m.svcMod.cancelOrgSubscription(depsWith(stripe), {
      orgId: o.id,
      actor: actor(),
      reason: "winding the company down",
    });
    expect(r).toMatchObject({ ok: true, outcome: "cancelled", accessRevoked: true, refundReview: "pending", emailSent: true });
    expect(stripe.calls.cancel).toEqual([o.sub]);
    expect(await status(o.id)).toBe("cancelled");

    const [row] = await ledger(o.id);
    expect(row).toMatchObject({
      stripe_subscription_id: o.sub,
      state: "confirmed",
      source: "owner",
      confirmed_via: "action",
      access_revoked: true,
      refund_review: "pending",
      requested_by: owner.id,
      requested_by_email: owner.email,
      reason: "winding the company down",
    });
    expect((row!.details as Record<string, unknown>).refund_basis).toBe("unused_prepaid_time");

    const a = await audit(o.id, "billing.subscription_cancelled_by_owner");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_id: owner.id, actor_email: owner.email });
    expect(a[0]!.metadata).toMatchObject({ access_revoked: true, refund_review: "pending", stripe_subscription_ids: [o.sub] });

    const hq = (await notices(o.id)).filter((n) => n.type === "stripe.subscription_cancelled");
    expect(hq).toEqual([{ audience: "hq", type: "stripe.subscription_cancelled", title: "Subscription cancelled by owner" }]);
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    expect(email.sendEmail.mock.calls[0]![0]).toMatchObject({ to: owner.email });

    // The projection reflects the cancel.
    const proj = (await svc().from("org_subscriptions").select("status").eq("org_id", o.id).maybeSingle()) as Res<{ status: string }>;
    expect(proj.data?.status).toBe("canceled");

    // Now Stripe's webhook arrives — long after.
    const wh = await m.processStripeEvent(subEvent("customer.subscription.deleted", o.customer!, o.sub!, "canceled"));
    expect(wh).toMatchObject({ status: "processed", actions: ["subscription_deleted:already_confirmed"] });
    expect((await notices(o.id)).filter((n) => n.type === "stripe.subscription_cancelled")).toHaveLength(1);
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    expect(await ledger(o.id)).toHaveLength(1);
  });

  it("TWO OWNERS / double-click at the same instant → ONE Stripe cancellation, one success + one 'in_progress', one ledger row", async () => {
    const o = await mkOrg("active");
    const stripe = fakeStripe(o.customer!, [{ id: o.sub!, status: "active" }], { delayMs: 250 });
    const deps = depsWith(stripe);
    const results = await Promise.all([
      m.svcMod.cancelOrgSubscription(deps, { orgId: o.id, actor: actor() }),
      m.svcMod.cancelOrgSubscription(deps, { orgId: o.id, actor: actor() }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "in_progress")).toHaveLength(1);
    expect(stripe.calls.cancel).toEqual([o.sub]);
    expect(await status(o.id)).toBe("cancelled");
    expect(await ledger(o.id)).toHaveLength(1);
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    expect(await audit(o.id, "billing.subscription_cancelled_by_owner")).toHaveLength(1);
  });

  it("WEBHOOK ARRIVES FIRST (cancelled in the Stripe dashboard), then the owner clicks cancel → already cancelled, nothing repeated", async () => {
    const o = await mkOrg("active");
    await m.processStripeEvent(subEvent("customer.subscription.deleted", o.customer!, o.sub!, "canceled"));
    const stripe = fakeStripe(o.customer!, [{ id: o.sub!, status: "canceled" }]);
    const r = await m.svcMod.cancelOrgSubscription(depsWith(stripe), { orgId: o.id, actor: actor() });
    expect(r).toMatchObject({ ok: true, outcome: "already_cancelled" });
    expect(stripe.calls.cancel).toEqual([]);
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect((await notices(o.id)).filter((n) => n.type === "stripe.subscription_cancelled")).toHaveLength(1);
  });

  it("STRIPE REFUSES → org stays active, claim is released as 'failed', failure audited; a retry then succeeds", async () => {
    const o = await mkOrg("active");
    const failing = fakeStripe(o.customer!, [{ id: o.sub!, status: "active" }], {
      fail: Object.assign(new Error("nope"), { type: "StripeInvalidRequestError" }),
    });
    const r1 = await m.svcMod.cancelOrgSubscription(depsWith(failing), { orgId: o.id, actor: actor() });
    expect(r1).toEqual({ ok: false, reason: "stripe_error" });
    expect(await status(o.id)).toBe("active");
    expect((await ledger(o.id)).map((x) => x.state)).toEqual(["failed"]);
    expect(await audit(o.id, "billing.subscription_cancel_failed")).toHaveLength(1);
    expect(email.sendEmail).not.toHaveBeenCalled();

    const working = fakeStripe(o.customer!, [{ id: o.sub!, status: "active" }]);
    const r2 = await m.svcMod.cancelOrgSubscription(depsWith(working), { orgId: o.id, actor: actor() });
    expect(r2).toMatchObject({ ok: true, outcome: "cancelled", accessRevoked: true });
    expect((await ledger(o.id)).map((x) => x.state)).toEqual(["confirmed"]);
  });

  it("TIMEOUT, outcome unknown → user is NOT told it is cancelled; when Stripe's webhook then arrives it revokes and sends the owner's email — once", async () => {
    const o = await mkOrg("active");
    const stripe = fakeStripe(o.customer!, [{ id: o.sub!, status: "active" }], {
      fail: Object.assign(new Error("Request timed out"), { type: "StripeConnectionError" }),
    });
    // Stripe still reports it live when we verify, so the action must refuse.
    const r = await m.svcMod.cancelOrgSubscription(depsWith(stripe), { orgId: o.id, actor: actor() });
    expect(r).toEqual({ ok: false, reason: "stripe_timeout" });
    expect(await status(o.id)).toBe("active");
    expect(email.sendEmail).not.toHaveBeenCalled();

    // In truth Stripe had accepted it: the webhook arrives.
    const wh = await m.processStripeEvent(subEvent("customer.subscription.deleted", o.customer!, o.sub!, "canceled"));
    expect(wh).toMatchObject({ status: "processed", actions: ["subscription_deleted:org_cancelled"] });
    expect(await status(o.id)).toBe("cancelled");
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    expect(email.sendEmail.mock.calls[0]![0]).toMatchObject({ to: owner.email });
    const [row] = await ledger(o.id);
    expect(row).toMatchObject({ state: "confirmed", source: "owner", confirmed_via: "webhook" });
  });

  it("TRIAL org with no Stripe subscription → local-only cancel revokes access; no Stripe call", async () => {
    const o = await mkOrg("trial", { customer: null, sub: null });
    const stripe = fakeStripe("cus_unused", []);
    const r = await m.svcMod.cancelOrgSubscription(
      { ...depsWith(stripe), stripeAvailable: () => false },
      { orgId: o.id, actor: actor() },
    );
    expect(r).toMatchObject({ ok: true, outcome: "cancelled", accessRevoked: true, refundReview: "not_applicable" });
    expect(await status(o.id)).toBe("cancelled");
    expect((await ledger(o.id))[0]).toMatchObject({ stripe_subscription_id: null, state: "confirmed" });
  });

  it("TRIALING Stripe subscription → cancelled, no refund review", async () => {
    const o = await mkOrg("active");
    const stripe = fakeStripe(o.customer!, [{ id: o.sub!, status: "trialing" }]);
    const r = await m.svcMod.cancelOrgSubscription(depsWith(stripe), { orgId: o.id, actor: actor() });
    expect(r).toMatchObject({ ok: true, refundReview: "not_applicable" });
    expect((await ledger(o.id))[0]).toMatchObject({ refund_review: "not_applicable" });
  });

  it("PAST_DUE (org suspended) → cancel revokes from suspended; a later dunning 'updated → unpaid' cannot move it", async () => {
    const o = await mkOrg("suspended");
    const stripe = fakeStripe(o.customer!, [{ id: o.sub!, status: "past_due" }]);
    const r = await m.svcMod.cancelOrgSubscription(depsWith(stripe), { orgId: o.id, actor: actor() });
    expect(r).toMatchObject({ ok: true, accessRevoked: true, refundReview: "not_applicable" });
    expect(await status(o.id)).toBe("cancelled");
    expect((await ledger(o.id))[0]).toMatchObject({ refund_review: "not_applicable" });
    await m.processStripeEvent(subEvent("customer.subscription.updated", o.customer!, o.sub!, "unpaid"));
    expect(await status(o.id)).toBe("cancelled");
  });

  it("RETRIES EXHAUSTED: Stripe cancels the subscription itself → org cancelled by the webhook; the owner pressing cancel afterwards is a no-op", async () => {
    const o = await mkOrg("suspended");
    await m.processStripeEvent(subEvent("customer.subscription.updated", o.customer!, o.sub!, "past_due"));
    expect(await status(o.id)).toBe("suspended");
    await m.processStripeEvent(subEvent("customer.subscription.deleted", o.customer!, o.sub!, "canceled"));
    expect(await status(o.id)).toBe("cancelled");
    const stripe = fakeStripe(o.customer!, [{ id: o.sub!, status: "canceled" }]);
    const r = await m.svcMod.cancelOrgSubscription(depsWith(stripe), { orgId: o.id, actor: actor() });
    expect(r).toMatchObject({ ok: true, outcome: "already_cancelled" });
  });

  it("ALREADY-CANCELLED org marked by hand with a still-live Stripe subscription → the subscription is terminated and tombstoned", async () => {
    const o = await mkOrg("cancelled");
    expect(await m.svcMod.isSubscriptionTombstoned(o.id, o.sub!)).toBe(false);
    const stripe = fakeStripe(o.customer!, [{ id: o.sub!, status: "active" }]);
    const r = await m.svcMod.cancelOrgSubscription(depsWith(stripe), { orgId: o.id, actor: actor() });
    expect(r).toMatchObject({ ok: true, outcome: "cancelled", subscriptionsCancelled: [o.sub] });
    expect(stripe.state.get(o.sub!)).toBe("canceled");
    expect(await m.svcMod.isSubscriptionTombstoned(o.id, o.sub!)).toBe(true);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // 5. After cancellation: billing history + reactivation
  // ══════════════════════════════════════════════════════════════════════════

  it("BILLING HISTORY is readable for a CANCELLED org (CrewFlow records; drafts hidden; newest first)", async () => {
    const o = await mkOrg("active");
    const ins = await svc().from("billing_invoices").insert([
      { org_id: o.id, kind: "subscription", status: "paid", amount_gbp: "500.00", paid_at: "2026-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z" },
      { org_id: o.id, kind: "subscription", status: "failed", amount_gbp: "500.00", created_at: "2026-10-01T00:00:00Z" },
      { org_id: o.id, kind: "subscription", status: "draft", amount_gbp: "500.00", created_at: "2026-11-01T00:00:00Z" },
    ]);
    expect(ins.error, ins.error?.message).toBeNull();
    await confirm(o.id, o.sub, "webhook");
    expect(await status(o.id)).toBe("cancelled");

    const deps = { ...m.history.wireBillingHistoryDeps(), stripeAvailable: () => false };
    const h = await m.history.loadBillingHistory(deps, o.id);
    expect(h.source).toBe("records");
    expect(h.invoices.map((i) => [i.status, i.amount, i.currency])).toEqual([
      ["failed", 500, "GBP"],
      ["paid", 500, "GBP"],
    ]);
    // …and it is org-pinned.
    const other = await mkOrg("cancelled");
    expect((await m.history.loadBillingHistory(deps, other.id)).invoices).toEqual([]);
  });

  it("REACTIVATION REQUEST: recorded + HQ alerted once; a repeat is deduped; then a new subscription restores access", async () => {
    const o = await mkOrg("active");
    await confirm(o.id, o.sub, "webhook");
    const deps = m.svcMod.wireReactivationDeps();
    const r1 = await m.svcMod.requestReactivation(deps, { orgId: o.id, actor: actor() });
    const r2 = await m.svcMod.requestReactivation(deps, { orgId: o.id, actor: actor() });
    expect([r1, r2]).toEqual([
      { ok: true, outcome: "requested" },
      { ok: true, outcome: "already_requested" },
    ]);
    expect(await audit(o.id, "billing.reactivation_requested")).toHaveLength(1);
    expect((await notices(o.id)).filter((n) => n.type === "stripe.reactivation_requested")).toHaveLength(1);
    // Asking changes no state.
    expect(await status(o.id)).toBe("cancelled");

    // HQ sends a checkout; the customer pays; Stripe reports the NEW subscription.
    const fresh = `sub_${TOKEN}_reactivated_${rand()}`;
    await m.processStripeEvent(checkoutEvent(o.id, o.customer!, fresh));
    await m.processStripeEvent(subEvent("customer.subscription.updated", o.customer!, fresh, "active"));
    expect(await status(o.id)).toBe("active");
    expect((await org(o.id)).cancelled_at).toBeNull();

    // …and that reactivated org can be cancelled again, cleanly.
    const stripe = fakeStripe(o.customer!, [{ id: fresh, status: "active" }]);
    const again = await m.svcMod.cancelOrgSubscription(depsWith(stripe), { orgId: o.id, actor: actor() });
    expect(again).toMatchObject({ ok: true, outcome: "cancelled", accessRevoked: true });
    expect((await ledger(o.id)).map((x) => x.state)).toEqual(["confirmed", "confirmed"]);
  });

  it("an active org cannot 'request reactivation'", async () => {
    const o = await mkOrg("active");
    const r = await m.svcMod.requestReactivation(m.svcMod.wireReactivationDeps(), { orgId: o.id, actor: actor() });
    expect(r).toEqual({ ok: false, reason: "not_cancelled" });
  });
});
