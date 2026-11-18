import { describe, it, expect, beforeEach, vi } from "vitest";
import type Stripe from "stripe";

/**
 * Stripe webhook — the RECORD-ONLY lifecycle paths, EXECUTED.
 *
 * `lifecycle-transitions.test.ts` (PR #988) proves the money-moving transitions:
 * setup paid, subscription active/past_due→suspended/cancelled, invoice
 * paid/failed, finalized/voided. It leaves four handler branches of the webhook
 * switch un-executed by any test — the ones that must observably do NOTHING to
 * an org's access or money:
 *
 *   • payment_intent.succeeded / payment_intent.payment_failed  → handlePaymentIntent
 *   • customer.created / customer.updated                        → handleCustomerUpsert
 *   • invoice.payment_action_required                           → handleInvoiceFailed (routing)
 *   • checkout.session.completed with neither org_id nor demo_id → no-op skip
 *
 * These matter specifically for the "no path creates a charge while self-serve
 * billing is dark" guarantee: a payment_intent event must be recorded for audit
 * but must NOT flip organizations.status, must NOT write a billing_invoices row,
 * and must NOT emit a billing notification — i.e. it opens no charge/activation
 * side effect. This file EXECUTES the real `processStripeEvent` against the same
 * chainable Supabase mock idiom as lifecycle-transitions.test.ts and asserts the
 * exact (minimal) write surface each branch produces.
 *
 * ADDITIVE: no production code is touched; the side-effect services are stubbed
 * so the assertion surface is precisely the organizations / billing_invoices
 * writes and the notification/health signals.
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
  const audit: Array<Record<string, unknown>> = [];
  const cfg: { orgRow: { id: string } | null } = { orgRow: { id: "org-1" } };

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
          maybeSingle: () => Promise.resolve({ data: cfg.orgRow, error: null }),
          limit: () => Promise.resolve({ data: [], error: null }),
        };
        return chain;
      },
      update: (payload: Record<string, unknown>) => {
        const rec: Op = { table, op: "update", payload, eqs: [] };
        ops.push(rec);
        const isReclaim = "claimed_at" in payload && "error_message" in payload;
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
    audit,
    cfg,
    createAdminClient: () => ({ from }),
  };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: h.createAdminClient }));
vi.mock("@/server/services/hq-audit", () => ({
  recordAdminActivity: async (a: Record<string, unknown>) => {
    h.audit.push(a);
  },
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
  onDemoStripePaymentConfirmed: async () => ({
    ok: true,
    done: true,
    failed: false,
    alreadyHandled: false,
  }),
}));
vi.mock("@/server/services/self-serve-billing", () => ({
  wireSelfServeBillingDeps: () => ({}),
  syncOrgSubscriptionFromStripe: async () => undefined,
}));

const { processStripeEvent } = await import(
  "@/server/services/stripe-webhook-handler"
);

// ---------------------------------------------------------------------------

let n = 0;
const freshId = () => `evt_ro_${Date.now()}_${n++}`;
const event = (type: string, object: Record<string, unknown>): Stripe.Event =>
  ({ id: freshId(), type, data: { object } }) as unknown as Stripe.Event;

const orgWrites = () =>
  h.ops.filter((o) => o.table === "organizations" && o.op === "update");
const invoiceInserts = () =>
  h.ops.filter((o) => o.table === "billing_invoices" && o.op === "insert");
const invoiceUpdates = () =>
  h.ops.filter((o) => o.table === "billing_invoices" && o.op === "update");
const mergedOrgUpdate = () =>
  Object.assign({}, ...orgWrites().map((o) => o.payload ?? {}));

beforeEach(() => {
  h.ops.length = 0;
  h.notifications.length = 0;
  h.health.length = 0;
  h.audit.length = 0;
  h.cfg.orgRow = { id: "org-1" };
});

// ===========================================================================
// payment_intent.* — audit-only, NEVER a charge/activation side effect
// ===========================================================================

describe("payment_intent.succeeded · record-only (no charge path opens)", () => {
  const ev = (status: string) =>
    event("payment_intent.succeeded", {
      id: "pi_1",
      customer: "cus_1",
      amount: 100_000,
      status,
    });

  it("records the intent but writes NOTHING to org status or billing_invoices", async () => {
    const res = await processStripeEvent(ev("succeeded"));
    expect(res.status).toBe("processed");
    if (res.status === "processed") {
      expect(res.actions).toContainEqual("pi:pi_1:succeeded");
    }
    // The crux: a payment_intent event must not flip access or record money.
    expect(orgWrites()).toHaveLength(0);
    expect(invoiceInserts()).toHaveLength(0);
    expect(invoiceUpdates()).toHaveLength(0);
    // ...and must not emit a billing notification (no customer-facing charge sig).
    expect(h.notifications).toHaveLength(0);
  });

  it("writes an audit trail scoped to the resolved org (no silent action)", async () => {
    await processStripeEvent(ev("succeeded"));
    expect(h.audit).toHaveLength(1);
    expect(h.audit[0]).toMatchObject({
      action: "stripe.pi_succeeded",
      targetId: "org-1",
    });
  });
});

describe("payment_intent.payment_failed · record-only", () => {
  it("records the failed intent without an org/invoice write or notification", async () => {
    const res = await processStripeEvent(
      event("payment_intent.payment_failed", {
        id: "pi_2",
        customer: "cus_1",
        amount: 50_000,
        status: "requires_payment_method",
      }),
    );
    expect(res.status).toBe("processed");
    if (res.status === "processed") {
      expect(res.actions).toContainEqual("pi:pi_2:requires_payment_method");
    }
    expect(orgWrites()).toHaveLength(0);
    expect(invoiceInserts()).toHaveLength(0);
    expect(h.notifications).toHaveLength(0);
    expect(h.audit[0]).toMatchObject({ action: "stripe.pi_payment_failed" });
  });
});

describe("payment_intent · unresolvable subject skips cleanly", () => {
  it("skips when the intent has no customer", async () => {
    const res = await processStripeEvent(
      event("payment_intent.succeeded", { id: "pi_3", status: "succeeded" }),
    );
    expect(res.status).toBe("processed");
    if (res.status === "processed") {
      expect(res.actions).toContainEqual("skipped:no_customer");
    }
    expect(h.audit).toHaveLength(0);
    expect(orgWrites()).toHaveLength(0);
  });

  it("skips when no org maps to the Stripe customer", async () => {
    h.cfg.orgRow = null;
    const res = await processStripeEvent(
      event("payment_intent.succeeded", {
        id: "pi_4",
        customer: "cus_unknown",
        status: "succeeded",
      }),
    );
    expect(res.status).toBe("processed");
    if (res.status === "processed") {
      expect(res.actions).toContainEqual("skipped:no_org_for_customer");
    }
    expect(h.audit).toHaveLength(0);
    expect(orgWrites()).toHaveLength(0);
  });
});

// ===========================================================================
// customer.created / customer.updated — keep the org↔customer link fresh
// ===========================================================================

describe("customer.created / customer.updated · link maintenance", () => {
  const ev = (type: string) =>
    event(type, {
      id: "cus_1",
      email: "owner@example.com",
      metadata: { org_id: "org-1" },
    });

  it.each(["customer.created", "customer.updated"])(
    "%s syncs stripe_customer_id + billing_email, scoped to the metadata org",
    async (type) => {
      const res = await processStripeEvent(ev(type));
      expect(res.status).toBe("processed");
      const merged = mergedOrgUpdate();
      expect(merged.stripe_customer_id).toBe("cus_1");
      expect(merged.billing_email).toBe("owner@example.com");
      expect(orgWrites().length).toBeGreaterThan(0);
      for (const o of orgWrites()) expect(o.eqs).toContainEqual(["id", "org-1"]);
      // Link maintenance only: no money recorded, no org status flip.
      expect(invoiceInserts()).toHaveLength(0);
      expect(merged).not.toHaveProperty("status");
      expect(merged).not.toHaveProperty("setup_fee_status");
    },
  );

  it("skips (no write) when the customer has no org_id in metadata", async () => {
    const res = await processStripeEvent(
      event("customer.updated", { id: "cus_x", email: "x@y.z" }),
    );
    expect(res.status).toBe("processed");
    if (res.status === "processed") {
      expect(res.actions).toContainEqual("skipped:no_org_id_metadata");
    }
    expect(orgWrites()).toHaveLength(0);
  });
});

// ===========================================================================
// invoice.payment_action_required — routes through the dunning handler
// ===========================================================================

describe("invoice.payment_action_required · routes to the failed-invoice handler", () => {
  it("records a failed invoice and notifies, same as payment_failed", async () => {
    const res = await processStripeEvent(
      event("invoice.payment_action_required", {
        id: "in_sca",
        customer: "cus_1",
        currency: "gbp",
        amount_due: 50_000,
        parent: { subscription_details: { subscription: "sub_1" } },
        last_finalization_error: { message: "authentication_required" },
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
      failure_reason: "authentication_required",
    });
    expect(h.notifications).toContain("failed_payment");
    // Dunning does not itself suspend the org — that's the subscription.updated
    // past_due path. So no organizations.status write here.
    expect(orgWrites()).toHaveLength(0);
  });
});

// ===========================================================================
// checkout.session.completed — neither org_id nor demo_id present
// ===========================================================================

describe("checkout.session.completed · no org_id and no demo_id", () => {
  it("is a clean no-op: no org/invoice write, no notification", async () => {
    const res = await processStripeEvent(
      event("checkout.session.completed", {
        id: "cs_orphan",
        customer: "cus_1",
        currency: "gbp",
        amount_total: 100_000,
        metadata: {},
      }),
    );
    expect(res.status).toBe("processed");
    if (res.status === "processed") {
      expect(res.actions).toContainEqual("skipped:no_org_id_in_metadata");
    }
    expect(orgWrites()).toHaveLength(0);
    expect(invoiceInserts()).toHaveLength(0);
    expect(h.notifications).toHaveLength(0);
  });
});
