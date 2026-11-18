import { describe, it, expect, beforeEach, vi } from "vitest";
import type Stripe from "stripe";

/**
 * Stripe billing LIFECYCLE — every state transition, EXECUTED.
 *
 * The sales-led lifecycle is: operator creates a customer → £1,000 setup fee →
 * £500/mo subscription → invoice.paid → org active → (past_due ⇒ suspended /
 * cancel). `contract.test.ts` pins the handler's SHAPE by grepping source;
 * `webhook-retry.test.ts` executes it but only through ONE event type
 * (customer.created) to prove the idempotency/retry machinery. Neither executes
 * the per-event BUSINESS transitions — the writes that actually flip an org to
 * active/suspended/cancelled and record the money.
 *
 * This file runs the real `processStripeEvent` against a chainable Supabase mock
 * (the `webhook-retry.test.ts` / `job-documents` idiom) and asserts the exact DB
 * writes each lifecycle event produces. All side-effect services (audit, health,
 * notifications, demo-lifecycle, the org_subscriptions projection) are stubbed so
 * the assertion surface is precisely the organizations / billing_invoices writes.
 */

type Op = {
  table: string;
  op: "insert" | "select" | "update";
  payload?: Record<string, unknown>;
  eqs: Array<[string, unknown]>;
};

const h = vi.hoisted(() => {
  const ops: Op[] = [];
  const notifications: string[] = [];
  const health: Array<[string, string]> = [];
  const demoCalls: Array<Record<string, unknown>> = [];
  const cfg: {
    /** Row returned by organizations.select(...).maybeSingle() → orgIdByCustomer. */
    orgRow: { id: string } | null;
  } = { orgRow: { id: "org-1" } };

  function from(table: string) {
    return {
      insert: (payload: Record<string, unknown>) => {
        ops.push({ table, op: "insert", payload, eqs: [] });
        // billing_events insert = the first-delivery claim; must succeed.
        return Promise.resolve({ data: null, error: null });
      },
      select: (_cols: string) => {
        const rec: Op = { table, op: "select", eqs: [] };
        ops.push(rec);
        const chain = {
          eq: (k: string, v: unknown) => {
            rec.eqs.push([k, v]);
            return chain;
          },
          maybeSingle: () =>
            Promise.resolve({ data: cfg.orgRow, error: null }),
          limit: () => Promise.resolve({ data: [], error: null }),
        };
        return chain;
      },
      update: (payload: Record<string, unknown>) => {
        const rec: Op = { table, op: "update", payload, eqs: [] };
        ops.push(rec);
        const isReclaim =
          "claimed_at" in payload && "error_message" in payload;
        const chain = {
          eq: (k: string, v: unknown) => {
            rec.eqs.push([k, v]);
            if (isReclaim) {
              const reclaim = {
                is: () => reclaim,
                or: () => reclaim,
                select: () => Promise.resolve({ data: [], error: null }),
              };
              return reclaim;
            }
            return Promise.resolve({ error: null });
          },
        };
        return chain;
      },
    };
  }

  return {
    ops,
    notifications,
    health,
    demoCalls,
    cfg,
    createAdminClient: () => ({ from }),
  };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: h.createAdminClient }));
vi.mock("@/server/services/hq-audit", () => ({
  recordAdminActivity: async () => undefined,
}));
vi.mock("@/server/services/hq-health-recompute", () => ({
  recomputeHealthForOrg: async (orgId: string, trigger: string) => {
    h.health.push([orgId, trigger]);
  },
}));
vi.mock("@/server/services/notifications-service", () => ({
  emitNotifications: async (n: { _tag?: string }) => {
    if (n?._tag) h.notifications.push(n._tag);
  },
}));
vi.mock("@/lib/notifications/events", () => ({
  notifyOnSetupFeePaid: () => ({ _tag: "setup_fee_paid" }),
  notifyOnSubscriptionStarted: () => ({ _tag: "subscription_started" }),
  notifyOnSubscriptionCancelled: () => ({ _tag: "subscription_cancelled" }),
  notifyOnFailedPayment: () => ({ _tag: "failed_payment" }),
}));
vi.mock("@/server/services/demo-lifecycle", () => ({
  onDemoStripePaymentConfirmed: async (args: Record<string, unknown>) => {
    h.demoCalls.push(args);
    return { ok: true, done: true, failed: false, alreadyHandled: false };
  },
}));
vi.mock("@/server/services/self-serve-billing", () => ({
  // projectOrgSubscription is best-effort + additive — stub it so the assertion
  // surface stays the organizations / billing_invoices writes.
  wireSelfServeBillingDeps: () => ({}),
  syncOrgSubscriptionFromStripe: async () => undefined,
}));

const { processStripeEvent } = await import(
  "@/server/services/stripe-webhook-handler"
);

// ---------------------------------------------------------------------------
// Fixtures + op selectors
// ---------------------------------------------------------------------------

let n = 0;
const freshId = () => `evt_lc_${Date.now()}_${n++}`;

const event = (type: string, object: Record<string, unknown>): Stripe.Event =>
  ({ id: freshId(), type, data: { object } }) as unknown as Stripe.Event;

const orgUpdates = () =>
  h.ops.filter((o) => o.table === "organizations" && o.op === "update");
const invoiceInserts = () =>
  h.ops.filter((o) => o.table === "billing_invoices" && o.op === "insert");
const invoiceUpdates = () =>
  h.ops.filter((o) => o.table === "billing_invoices" && o.op === "update");
/** The merged organizations.update payload (handlers may write in >1 call). */
const mergedOrgUpdate = () =>
  Object.assign({}, ...orgUpdates().map((o) => o.payload ?? {}));

beforeEach(() => {
  h.ops.length = 0;
  h.notifications.length = 0;
  h.health.length = 0;
  h.demoCalls.length = 0;
  h.cfg.orgRow = { id: "org-1" };
});

// ===========================================================================
// checkout.session.completed — £1,000 setup fee (ORG flow)
// ===========================================================================

describe("checkout.session.completed · setup_fee (£1,000)", () => {
  const ev = () =>
    event("checkout.session.completed", {
      id: "cs_setup",
      customer: "cus_1",
      currency: "gbp",
      amount_total: 100_000,
      payment_intent: "pi_setup",
      metadata: { org_id: "org-1", kind: "setup_fee", actor_id: "admin-1" },
    });

  it("marks the org's setup fee paid and persists the Stripe customer id", async () => {
    const res = await processStripeEvent(ev());
    expect(res.status).toBe("processed");
    const merged = mergedOrgUpdate();
    expect(merged.stripe_customer_id).toBe("cus_1");
    expect(merged.setup_fee_status).toBe("paid");
    expect(merged.setup_fee_paid_at).toBeTruthy();
    // Every org write is scoped to this org id (never an unfiltered update).
    expect(orgUpdates().length).toBeGreaterThan(0);
    for (const o of orgUpdates()) expect(o.eqs).toContainEqual(["id", "org-1"]);
  });

  it("records a paid setup_fee billing invoice for £1,000", async () => {
    await processStripeEvent(ev());
    const ins = invoiceInserts();
    expect(ins).toHaveLength(1);
    expect(ins[0]!.payload).toMatchObject({
      org_id: "org-1",
      kind: "setup_fee",
      status: "paid",
      amount_gbp: "1000.00",
      currency: "GBP",
      stripe_payment_intent_id: "pi_setup",
    });
  });

  it("notifies the setup-fee-paid event and recomputes org health", async () => {
    await processStripeEvent(ev());
    expect(h.notifications).toContain("setup_fee_paid");
    expect(h.health).toContainEqual(["org-1", "payment_change"]);
  });
});

// ===========================================================================
// checkout.session.completed — £500/mo subscription (ORG flow)
// ===========================================================================

describe("checkout.session.completed · subscription (£500/mo)", () => {
  it("activates the org and records the subscription id", async () => {
    const res = await processStripeEvent(
      event("checkout.session.completed", {
        id: "cs_sub",
        customer: "cus_1",
        currency: "gbp",
        amount_total: 50_000,
        subscription: "sub_1",
        metadata: { org_id: "org-1", kind: "subscription", actor_id: "admin-1" },
      }),
    );
    expect(res.status).toBe("processed");
    const merged = mergedOrgUpdate();
    expect(merged.status).toBe("active");
    expect(merged.stripe_subscription_id).toBe("sub_1");
    expect(h.notifications).toContain("subscription_started");
  });
});

// ===========================================================================
// checkout.session.completed — DEMO flow (no org yet)
// ===========================================================================

describe("checkout.session.completed · demo setup fee (pre-provisioning)", () => {
  it("routes to the demo-lifecycle confirmation and makes NO org write", async () => {
    const res = await processStripeEvent(
      event("checkout.session.completed", {
        id: "cs_demo",
        customer: "cus_demo",
        currency: "gbp",
        amount_total: 100_000,
        payment_intent: "pi_demo",
        metadata: { demo_id: "demo-9", company: "Acme" },
      }),
    );
    expect(res.status).toBe("processed");
    expect(h.demoCalls).toHaveLength(1);
    expect(h.demoCalls[0]).toMatchObject({ demoId: "demo-9", amountGbp: 1000 });
    // No org exists yet → no organizations / billing_invoices writes.
    expect(orgUpdates()).toHaveLength(0);
    expect(invoiceInserts()).toHaveLength(0);
  });
});

// ===========================================================================
// customer.subscription.updated — status machine
// ===========================================================================

describe("customer.subscription.updated · status → org.status", () => {
  const subEvent = (status: string) =>
    event("customer.subscription.updated", {
      id: "sub_1",
      status,
      customer: "cus_1",
      current_period_end: 1_900_000_000,
    });

  it("active → org active, with next_renewal_at set", async () => {
    await processStripeEvent(subEvent("active"));
    const merged = mergedOrgUpdate();
    expect(merged.status).toBe("active");
    expect(merged.stripe_subscription_id).toBe("sub_1");
    expect(merged.next_renewal_at).toBe(
      new Date(1_900_000_000 * 1000).toISOString(),
    );
  });

  it("past_due → org suspended", async () => {
    await processStripeEvent(subEvent("past_due"));
    expect(mergedOrgUpdate().status).toBe("suspended");
  });

  it("unpaid → org suspended", async () => {
    await processStripeEvent(subEvent("unpaid"));
    expect(mergedOrgUpdate().status).toBe("suspended");
  });

  it("canceled → org cancelled", async () => {
    await processStripeEvent(subEvent("canceled"));
    expect(mergedOrgUpdate().status).toBe("cancelled");
  });

  it("trialing → org active (trial grants access)", async () => {
    await processStripeEvent(subEvent("trialing"));
    expect(mergedOrgUpdate().status).toBe("active");
  });

  it("resolves the org via stripe_customer_id when there is no metadata", async () => {
    await processStripeEvent(subEvent("active"));
    const sel = h.ops.find(
      (o) => o.table === "organizations" && o.op === "select",
    );
    expect(sel?.eqs).toContainEqual(["stripe_customer_id", "cus_1"]);
  });

  it("skips cleanly when no org maps to the Stripe customer", async () => {
    h.cfg.orgRow = null;
    const res = await processStripeEvent(subEvent("active"));
    expect(res.status).toBe("processed");
    expect(orgUpdates()).toHaveLength(0);
  });
});

// ===========================================================================
// customer.subscription.deleted — NOT a silent auto-cancel
// ===========================================================================

describe("customer.subscription.deleted · operator decision, not automatic", () => {
  it("records + notifies but does NOT flip organizations.status", async () => {
    const res = await processStripeEvent(
      event("customer.subscription.deleted", {
        id: "sub_1",
        status: "canceled",
        customer: "cus_1",
      }),
    );
    expect(res.status).toBe("processed");
    // High-blast-radius: the org is left for the operator to decide.
    expect(orgUpdates()).toHaveLength(0);
    expect(h.notifications).toContain("subscription_cancelled");
  });
});

// ===========================================================================
// invoice.paid / invoice.payment_failed
// ===========================================================================

describe("invoice.paid · recurring subscription invoice", () => {
  it("records a paid subscription invoice for £500", async () => {
    const res = await processStripeEvent(
      event("invoice.paid", {
        id: "in_1",
        customer: "cus_1",
        currency: "gbp",
        amount_paid: 50_000,
        status_transitions: { paid_at: 1_800_000_000 },
        // Newer Stripe shape: the subscription ref lives under parent.*
        parent: { subscription_details: { subscription: "sub_1" } },
      }),
    );
    expect(res.status).toBe("processed");
    // Upsert-by-stripe_invoice_id: an UPDATE then a guarded INSERT.
    const upd = invoiceUpdates();
    expect(upd).toHaveLength(1);
    expect(upd[0]!.payload).toMatchObject({ status: "paid", amount_gbp: "500.00" });
    expect(upd[0]!.eqs).toContainEqual(["stripe_invoice_id", "in_1"]);
    const ins = invoiceInserts();
    expect(ins).toHaveLength(1);
    expect(ins[0]!.payload).toMatchObject({
      org_id: "org-1",
      kind: "subscription", // resolved from parent.subscription_details
      status: "paid",
      amount_gbp: "500.00",
    });
    expect(h.health).toContainEqual(["org-1", "payment_change"]);
  });

  it("classifies a one-off invoice (no subscription ref) as a setup_fee", async () => {
    await processStripeEvent(
      event("invoice.paid", {
        id: "in_oneoff",
        customer: "cus_1",
        currency: "gbp",
        amount_paid: 100_000,
      }),
    );
    expect(invoiceInserts()[0]!.payload).toMatchObject({
      kind: "setup_fee",
      amount_gbp: "1000.00",
    });
  });
});

describe("invoice.payment_failed · dunning", () => {
  it("records a failed invoice with the reason and notifies loudly", async () => {
    const res = await processStripeEvent(
      event("invoice.payment_failed", {
        id: "in_fail",
        customer: "cus_1",
        currency: "gbp",
        amount_due: 50_000,
        parent: { subscription_details: { subscription: "sub_1" } },
        last_finalization_error: { message: "card_declined" },
      }),
    );
    expect(res.status).toBe("processed");
    const ins = invoiceInserts();
    expect(ins).toHaveLength(1);
    expect(ins[0]!.payload).toMatchObject({
      org_id: "org-1",
      kind: "subscription",
      status: "failed",
      amount_gbp: "500.00",
      failure_reason: "card_declined",
    });
    expect(h.notifications).toContain("failed_payment");
  });
});

// ===========================================================================
// invoice.finalized / invoice.voided — status-only transitions
// ===========================================================================

describe("invoice status-only transitions", () => {
  it("invoice.finalized marks the invoice 'sent'", async () => {
    await processStripeEvent(
      event("invoice.finalized", { id: "in_f", customer: "cus_1" }),
    );
    const upd = invoiceUpdates();
    expect(upd).toHaveLength(1);
    expect(upd[0]!.payload).toMatchObject({ status: "sent" });
  });

  it("invoice.voided marks the invoice 'void'", async () => {
    await processStripeEvent(
      event("invoice.voided", { id: "in_v", customer: "cus_1" }),
    );
    expect(invoiceUpdates()[0]!.payload).toMatchObject({ status: "void" });
  });
});

// ===========================================================================
// Unhandled event types are stored, not actioned
// ===========================================================================

describe("unhandled event types", () => {
  it("are stored (billing_events) and skipped — no org/invoice side effects", async () => {
    const res = await processStripeEvent(
      event("charge.dispute.created", { id: "dp_1", customer: "cus_1" }),
    );
    expect(res.status).toBe("skipped");
    expect(orgUpdates()).toHaveLength(0);
    expect(invoiceInserts()).toHaveLength(0);
    // Still recorded for replay.
    expect(h.ops.some((o) => o.table === "billing_events" && o.op === "insert")).toBe(
      true,
    );
  });
});
