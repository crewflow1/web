import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type Stripe from "stripe";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Stripe billing LIFECYCLE — behavioural, real-Postgres coverage of the
 * recurring/renewal/cancellation/reactivation state machine, driving
 * processStripeEvent with synthetic Stripe.Event objects and asserting the
 * real org / billing_invoices DB effects.
 *
 * Companion to webhook-claim-concurrency.test.ts (which proves the claim /
 * idempotency machinery). This file proves the DOWNSTREAM transitions that
 * fire once an event is dispatched.
 *
 * ARCHITECTURE NOTE established by these tests:
 *   customer.subscription.* is the single AUTHORITY on organizations.status.
 *   The invoice.* handlers are a LEDGER + NOTIFY layer: they write
 *   billing_invoices and emit notifications but deliberately never mutate
 *   organizations.status (Stripe always pairs a failed/recovered renewal with
 *   a customer.subscription.updated carrying the new subscription status).
 *   The org status enum has no 'past_due'; Stripe past_due/unpaid map to
 *   'suspended', canceled maps to 'cancelled'.
 */

type Db = {
  from: (t: string) => {
    insert: (v: unknown) => {
      select: (c: string) => {
        single: () => Promise<{
          data: Record<string, unknown> | null;
          error: { message: string } | null;
        }>;
      };
    } & Promise<{ error: { message: string } | null }>;
    select: (c: string) => {
      eq: (k: string, v: unknown) => Promise<{
        data: unknown[] | null;
        error: { message: string } | null;
      }> & {
        eq: (k: string, v: unknown) => Promise<{
          data: unknown[] | null;
          error: { message: string } | null;
        }>;
      };
    };
    update: (v: unknown) => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
    };
    delete: () => {
      eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }>;
    };
  };
};
const db = (c: unknown): Db => c as unknown as Db;

const TOKEN = `it-life-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("stripe webhook · billing lifecycle", () => {
  // Two tenants so every mutation can be checked for cross-tenant leakage.
  let orgA = "";
  let orgB = "";
  const custA = `cus_${TOKEN}_A`;
  const custB = `cus_${TOKEN}_B`;

  let processStripeEvent: typeof import("@/server/services/stripe-webhook-handler").processStripeEvent;

  const freshEventId = () =>
    `evt_${TOKEN}_${Math.random().toString(36).slice(2, 10)}`;
  const freshInvId = () =>
    `in_${TOKEN}_${Math.random().toString(36).slice(2, 10)}`;
  const freshSubId = () =>
    `sub_${TOKEN}_${Math.random().toString(36).slice(2, 10)}`;

  // ---- event builders --------------------------------------------------

  const invoicePaidEvent = (
    invId: string,
    customer: string,
    subscriptionRef: string | null,
    amountPaidPence = 50_000,
  ): Stripe.Event =>
    ({
      id: freshEventId(),
      type: "invoice.paid",
      data: {
        object: {
          id: invId,
          customer,
          amount_paid: amountPaidPence,
          amount_due: amountPaidPence,
          currency: "gbp",
          // newest-shape subscription ref (events.ts invoiceSubscriptionId)
          parent: subscriptionRef
            ? { subscription_details: { subscription: subscriptionRef } }
            : undefined,
          status_transitions: { paid_at: Math.floor(Date.now() / 1000) },
        },
      },
    }) as unknown as Stripe.Event;

  const invoiceFailedEvent = (
    invId: string,
    customer: string,
    subscriptionRef: string | null,
    type:
      | "invoice.payment_failed"
      | "invoice.payment_action_required" = "invoice.payment_failed",
    amountDuePence = 50_000,
  ): Stripe.Event =>
    ({
      id: freshEventId(),
      type,
      data: {
        object: {
          id: invId,
          customer,
          amount_due: amountDuePence,
          currency: "gbp",
          parent: subscriptionRef
            ? { subscription_details: { subscription: subscriptionRef } }
            : undefined,
          last_finalization_error: { message: "card_declined (probe)" },
        },
      },
    }) as unknown as Stripe.Event;

  const subscriptionEvent = (
    subId: string,
    customer: string,
    status: string,
    type:
      | "customer.subscription.updated"
      | "customer.subscription.created"
      | "customer.subscription.deleted" = "customer.subscription.updated",
  ): Stripe.Event =>
    ({
      id: freshEventId(),
      type,
      data: {
        object: {
          id: subId,
          customer,
          status,
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
        },
      },
    }) as unknown as Stripe.Event;

  const checkoutSubscriptionEvent = (
    orgId: string,
    customer: string,
    subId: string,
  ): Stripe.Event =>
    ({
      id: freshEventId(),
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_${freshEventId()}`,
          customer,
          subscription: subId,
          payment_status: "paid",
          metadata: { org_id: orgId, kind: "subscription" },
        },
      },
    }) as unknown as Stripe.Event;

  // ---- DB probes -------------------------------------------------------

  const orgStatus = async (orgId: string) => {
    const r = await db(serviceClient())
      .from("organizations")
      .select("status")
      .eq("id", orgId);
    expect(r.error, r.error?.message).toBeNull();
    return ((r.data ?? [])[0] as { status: string } | undefined)?.status;
  };
  const setOrgStatus = async (orgId: string, s: string) => {
    const r = await db(serviceClient())
      .from("organizations")
      .update({ status: s })
      .eq("id", orgId);
    expect(r.error, r.error?.message).toBeNull();
  };
  const setCustomerId = async (orgId: string, cust: string | null) => {
    const r = await db(serviceClient())
      .from("organizations")
      .update({ stripe_customer_id: cust })
      .eq("id", orgId);
    expect(r.error, r.error?.message).toBeNull();
  };
  const invoiceRows = async (orgId: string) => {
    const r = await db(serviceClient())
      .from("billing_invoices")
      .select("id, kind, status, amount_gbp, stripe_invoice_id")
      .eq("org_id", orgId);
    expect(r.error, r.error?.message).toBeNull();
    return (r.data ?? []) as Array<Record<string, unknown>>;
  };
  const invoiceRowsFor = async (orgId: string, stripeInvoiceId: string) =>
    (await invoiceRows(orgId)).filter(
      (row) => row.stripe_invoice_id === stripeInvoiceId,
    );

  // ---- fixtures --------------------------------------------------------

  beforeAll(async () => {
    const svc = db(serviceClient());
    const a = await svc
      .from("organizations")
      .insert({
        name: "Lifecycle Org A",
        slug: `${TOKEN}-a`,
        stripe_customer_id: custA,
        status: "active",
      })
      .select("id")
      .single();
    expect(a.error, a.error?.message).toBeNull();
    orgA = a.data?.id as string;

    const b = await svc
      .from("organizations")
      .insert({
        name: "Lifecycle Org B",
        slug: `${TOKEN}-b`,
        stripe_customer_id: custB,
        status: "active",
      })
      .select("id")
      .single();
    expect(b.error, b.error?.message).toBeNull();
    orgB = b.data?.id as string;

    if (!orgA || !orgB) throw new Error("failed to create probe orgs");

    const mod = await import("@/server/services/stripe-webhook-handler");
    processStripeEvent = mod.processStripeEvent;
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    for (const id of [orgA, orgB]) {
      if (id) {
        await svc.from("billing_invoices").delete().eq("org_id", id);
        await svc.from("organizations").delete().eq("id", id);
      }
    }
  });

  beforeEach(async () => {
    const svc = db(serviceClient());
    for (const id of [orgA, orgB]) {
      await svc.from("billing_invoices").delete().eq("org_id", id);
    }
    await setCustomerId(orgA, custA);
    await setCustomerId(orgB, custB);
    await setOrgStatus(orgA, "active");
    await setOrgStatus(orgB, "active");
  });

  // ===================================================================
  // 1. Recurring invoice.paid → ledger row recorded ONCE; org stays active
  // ===================================================================

  it("recurring invoice.paid records exactly one 'subscription' billing_invoices row", async () => {
    const invId = freshInvId();
    const res = await processStripeEvent(
      invoicePaidEvent(invId, custA, freshSubId()),
    );
    expect(res.status).toBe("processed");
    const rows = await invoiceRowsFor(orgA, invId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("subscription");
    expect(rows[0]?.status).toBe("paid");
    expect(Number(rows[0]?.amount_gbp)).toBe(500);
  });

  it("an already-active org STAYS active on a recurring invoice.paid", async () => {
    await processStripeEvent(invoicePaidEvent(freshInvId(), custA, freshSubId()));
    expect(await orgStatus(orgA)).toBe("active");
  });

  it("the SAME invoice delivered via two distinct events is recorded ONCE (unique-index idempotency)", async () => {
    const invId = freshInvId();
    const subRef = freshSubId();
    // Two different Stripe event ids, same underlying invoice id. Event-level
    // idempotency does NOT dedupe these (different event_id); the partial unique
    // index on stripe_invoice_id must.
    await processStripeEvent(invoicePaidEvent(invId, custA, subRef));
    await processStripeEvent(invoicePaidEvent(invId, custA, subRef));
    expect(await invoiceRowsFor(orgA, invId)).toHaveLength(1);
  });

  // ===================================================================
  // 2. invoice.payment_failed / payment_action_required
  //    → 'failed' ledger row; status authority stays with subscription.*
  // ===================================================================

  it("invoice.payment_failed records a 'failed' billing_invoices row", async () => {
    const invId = freshInvId();
    const res = await processStripeEvent(
      invoiceFailedEvent(invId, custA, freshSubId()),
    );
    expect(res.status).toBe("processed");
    const rows = await invoiceRowsFor(orgA, invId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.kind).toBe("subscription");
  });

  it("invoice.payment_action_required is handled like a failed invoice", async () => {
    const invId = freshInvId();
    const res = await processStripeEvent(
      invoiceFailedEvent(invId, custA, freshSubId(), "invoice.payment_action_required"),
    );
    expect(res.status).toBe("processed");
    const rows = await invoiceRowsFor(orgA, invId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
  });

  it("invoice.payment_failed does NOT by itself change org.status (subscription.* is the authority)", async () => {
    await processStripeEvent(invoiceFailedEvent(freshInvId(), custA, freshSubId()));
    // Unchanged here — the paired customer.subscription.updated(past_due) is what
    // suspends (next test).
    expect(await orgStatus(orgA)).toBe("active");
  });

  it("customer.subscription.updated(past_due) suspends the org (the real past_due transition)", async () => {
    await processStripeEvent(
      subscriptionEvent(freshSubId(), custA, "past_due"),
    );
    expect(await orgStatus(orgA)).toBe("suspended");
  });

  it("customer.subscription.updated(unpaid) also suspends the org", async () => {
    await processStripeEvent(subscriptionEvent(freshSubId(), custA, "unpaid"));
    expect(await orgStatus(orgA)).toBe("suspended");
  });

  it("a recovered payment returns a suspended org to active via subscription.updated(active)", async () => {
    await setOrgStatus(orgA, "suspended");
    await processStripeEvent(subscriptionEvent(freshSubId(), custA, "active"));
    expect(await orgStatus(orgA)).toBe("active");
  });

  it("subscription.updated(trialing) keeps the org active", async () => {
    await setOrgStatus(orgA, "pending");
    await processStripeEvent(subscriptionEvent(freshSubId(), custA, "trialing"));
    expect(await orgStatus(orgA)).toBe("active");
  });

  it("subscription.updated(incomplete) leaves org.status untouched", async () => {
    await setOrgStatus(orgA, "active");
    await processStripeEvent(subscriptionEvent(freshSubId(), custA, "incomplete"));
    expect(await orgStatus(orgA)).toBe("active");
    // and from a suspended baseline it is likewise left alone
    await setOrgStatus(orgA, "suspended");
    await processStripeEvent(subscriptionEvent(freshSubId(), custA, "incomplete"));
    expect(await orgStatus(orgA)).toBe("suspended");
  });

  // ===================================================================
  // 3. customer.subscription.deleted → org is NOT auto-cancelled
  // ===================================================================

  it("customer.subscription.deleted does NOT auto-cancel the org (documented decision)", async () => {
    await setOrgStatus(orgA, "active");
    const res = await processStripeEvent(
      subscriptionEvent(freshSubId(), custA, "canceled", "customer.subscription.deleted"),
    );
    expect(res.status).toBe("processed");
    expect((res as { actions?: string[] }).actions).toContain(
      "subscription_deleted_recorded",
    );
    // Access is retained; an operator decides the cancel via /admin/customers.
    expect(await orgStatus(orgA)).toBe("active");
  });

  // ===================================================================
  // 4. Reactivation: cancelled → active
  // ===================================================================

  it("subscription.updated(canceled) cancels, then (active) reactivates the org", async () => {
    await processStripeEvent(subscriptionEvent(freshSubId(), custA, "canceled"));
    expect(await orgStatus(orgA)).toBe("cancelled");

    await processStripeEvent(subscriptionEvent(freshSubId(), custA, "active"));
    expect(await orgStatus(orgA)).toBe("active");
  });

  // ===================================================================
  // 5. Out-of-order: subscription.updated BEFORE checkout.session.completed
  // ===================================================================

  it("subscription.updated arriving before the customer link is skipped, then checkout.completed converges to active", async () => {
    // Org not yet linked to a Stripe customer (checkout hasn't run).
    await setCustomerId(orgA, null);
    await setOrgStatus(orgA, "pending");
    const subId = freshSubId();

    // Out-of-order subscription.updated(active): no org resolvable → skipped,
    // and crucially NOTHING is mutated.
    const early = await processStripeEvent(
      subscriptionEvent(subId, custA, "active"),
    );
    expect(early.status).toBe("processed");
    expect((early as { actions?: string[] }).actions).toContain(
      "skipped:no_org_for_customer",
    );
    expect(await orgStatus(orgA)).toBe("pending"); // untouched

    // Then checkout.session.completed(paid) links the customer and activates.
    const checkout = await processStripeEvent(
      checkoutSubscriptionEvent(orgA, custA, subId),
    );
    expect(checkout.status).toBe("processed");
    expect(await orgStatus(orgA)).toBe("active"); // consistent final state
  });

  // ===================================================================
  // 6. Cross-tenant isolation: an event for A never mutates B
  // ===================================================================

  it("subscription.updated(past_due) for A's customer leaves B active", async () => {
    await processStripeEvent(subscriptionEvent(freshSubId(), custA, "past_due"));
    expect(await orgStatus(orgA)).toBe("suspended");
    expect(await orgStatus(orgB)).toBe("active"); // B untouched
  });

  it("invoice.paid for A's customer writes NO billing_invoices row for B", async () => {
    await processStripeEvent(invoicePaidEvent(freshInvId(), custA, freshSubId()));
    expect(await invoiceRows(orgA)).toHaveLength(1);
    expect(await invoiceRows(orgB)).toHaveLength(0);
  });

  it("invoice.payment_failed for A's customer never touches B's status or ledger", async () => {
    await processStripeEvent(invoiceFailedEvent(freshInvId(), custA, freshSubId()));
    expect(await invoiceRows(orgB)).toHaveLength(0);
    expect(await orgStatus(orgB)).toBe("active");
  });

  it("subscription.deleted for A's customer leaves B active", async () => {
    await processStripeEvent(
      subscriptionEvent(freshSubId(), custA, "canceled", "customer.subscription.deleted"),
    );
    expect(await orgStatus(orgB)).toBe("active");
  });
});
