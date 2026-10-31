import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";

/**
 * Stripe SALES-LED LIFECYCLE — behavioural org-state transitions.
 *
 * CrewFlow sells a £1,000 one-off setup fee + £500/mo subscription, sales-led
 * (self-serve billing OFF). The webhook handler is what translates Stripe's
 * events into CrewFlow org state — this is CrewFlow's own revenue capture, and
 * the only machine-readable record of who has paid.
 *
 * The existing __tests__/stripe/contract.test.ts pins the handler SOURCE TEXT
 * (`/"canceled"/`, `/"past_due"/`, `/subscription_deleted_recorded/`). A source
 * pin stays green even if the status-mapping ternary is inverted, so it cannot
 * prove the TRANSITION is correct. __tests__/stripe/webhook-retry.test.ts
 * executes the handler but only for `customer.created` (idempotency). Neither
 * executes the money-event → org-state transitions. These tests do, against the
 * same chainable Supabase mock, with every downstream side-effect service
 * (audit / health / notifications / demo-lifecycle / self-serve projection)
 * mocked to a no-op so the handler's OWN writes to `organizations` /
 * `billing_invoices` are the only observable signal.
 *
 * No real Stripe call is made: events are plain fixtures.
 */

type Op = {
  table: string;
  op: "insert" | "select" | "update";
  payload?: Record<string, unknown>;
  eqs: Array<[string, unknown]>;
};

const h = vi.hoisted(() => {
  const ops: Op[] = [];
  const cfg: {
    // org row returned by orgIdByCustomer's select(...).maybeSingle().
    orgRow: { id: string } | null;
    // billing_events INSERT outcome — null = first-delivery claim succeeds.
    insertError: { message: string; code?: string } | null;
    // billing_events reclaim UPDATE ... RETURNING rows ([] = already done).
    reclaimReturns: Array<{ id: string }>;
  } = {
    orgRow: { id: "org-xyz" },
    insertError: null,
    reclaimReturns: [],
  };

  function from(table: string) {
    return {
      insert: (payload: Record<string, unknown>) => {
        ops.push({ table, op: "insert", payload, eqs: [] });
        const error = table === "billing_events" ? cfg.insertError : null;
        return Promise.resolve({ data: null, error });
      },
      select: () => {
        const rec: Op = { table, op: "select", eqs: [] };
        ops.push(rec);
        const query = {
          eq: (k: string, v: unknown) => {
            rec.eqs.push([k, v]);
            return query;
          },
          maybeSingle: () =>
            Promise.resolve({ data: cfg.orgRow, error: null }),
        };
        return query;
      },
      update: (payload: Record<string, unknown>) => {
        const rec: Op = { table, op: "update", payload, eqs: [] };
        ops.push(rec);
        const isReclaim = "claimed_at" in payload;
        return {
          eq: (k: string, v: unknown) => {
            rec.eqs.push([k, v]);
            if (isReclaim) {
              const reclaimChain = {
                is: () => reclaimChain,
                or: () => reclaimChain,
                select: () =>
                  Promise.resolve({ data: cfg.reclaimReturns, error: null }),
              };
              return reclaimChain;
            }
            return Promise.resolve({ error: null });
          },
        };
      },
    };
  }

  return { ops, cfg, createAdminClient: () => ({ from }) };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: h.createAdminClient,
}));

// Side-effect services — mocked to no-ops so only the handler's own
// organizations / billing_invoices writes are observable.
vi.mock("@/server/services/hq-audit", () => ({
  recordAdminActivity: vi.fn(async () => undefined),
}));
vi.mock("@/server/services/hq-health-recompute", () => ({
  recomputeHealthForOrg: vi.fn(async () => undefined),
}));
vi.mock("@/server/services/notifications-service", () => ({
  emitNotifications: vi.fn(async () => undefined),
}));
vi.mock("@/lib/notifications/events", () => ({
  notifyOnSetupFeePaid: vi.fn(() => ({})),
  notifyOnSubscriptionStarted: vi.fn(() => ({})),
  notifyOnSubscriptionCancelled: vi.fn(() => ({})),
  notifyOnFailedPayment: vi.fn(() => ({})),
}));
const demoConfirm = vi.fn(async () => ({
  ok: true,
  done: [] as string[],
  failed: [] as { step: string; reason: string }[],
  alreadyHandled: false,
}));
vi.mock("@/server/services/demo-lifecycle", () => ({
  onDemoStripePaymentConfirmed: demoConfirm,
}));
vi.mock("@/server/services/self-serve-billing", () => ({
  wireSelfServeBillingDeps: vi.fn(() => ({})),
  syncOrgSubscriptionFromStripe: vi.fn(async () => undefined),
}));

const { processStripeEvent } = await import(
  "@/server/services/stripe-webhook-handler"
);

// --- fixtures --------------------------------------------------------

function evt(type: string, object: Record<string, unknown>): Stripe.Event {
  return {
    id: `evt_${type}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    created: 1700000000,
    livemode: true,
    data: { object },
  } as unknown as Stripe.Event;
}

// --- observers -------------------------------------------------------

const orgUpdates = () =>
  h.ops.filter((o) => o.table === "organizations" && o.op === "update");
const invoiceInserts = () =>
  h.ops.filter((o) => o.table === "billing_invoices" && o.op === "insert");
const invoiceUpdates = () =>
  h.ops.filter((o) => o.table === "billing_invoices" && o.op === "update");
/** The org update carrying a `status`, if any (the state transition). */
const orgStatusUpdate = () =>
  orgUpdates().find((o) => o.payload && "status" in o.payload);

/** Narrow a ProcessResult to the `processed` variant so `.actions` is typed. */
function expectProcessed(
  res: Awaited<ReturnType<typeof processStripeEvent>>,
): Extract<typeof res, { status: "processed" }> {
  if (res.status !== "processed") {
    throw new Error(`expected status 'processed', got '${res.status}'`);
  }
  return res;
}

beforeEach(() => {
  h.ops.length = 0;
  h.cfg.orgRow = { id: "org-xyz" };
  h.cfg.insertError = null;
  h.cfg.reclaimReturns = [];
  demoConfirm.mockClear();
});

// =====================================================================
// checkout.session.completed — the sales-led org activation path
// =====================================================================

describe("checkout.session.completed — setup fee (org flow)", () => {
  it("marks the org setup_fee paid and records a £1,000 billing_invoice", async () => {
    const res = await processStripeEvent(
      evt("checkout.session.completed", {
        id: "cs_1",
        metadata: { org_id: "org-xyz", kind: "setup_fee" },
        customer: "cus_1",
        amount_total: 100_000,
        currency: "gbp",
        payment_intent: "pi_1",
      }),
    );
    expect(res.status).toBe("processed");

    const feeUpdate = orgUpdates().find(
      (o) => o.payload && "setup_fee_status" in o.payload,
    );
    expect(feeUpdate?.payload?.setup_fee_status).toBe("paid");
    expect(feeUpdate?.payload?.setup_fee_paid_at).toBeTruthy();
    expect(feeUpdate?.eqs).toContainEqual(["id", "org-xyz"]);

    // stripe_customer_id persisted onto the org.
    expect(
      orgUpdates().some(
        (o) => o.payload?.stripe_customer_id === "cus_1",
      ),
    ).toBe(true);

    const inv = invoiceInserts()[0];
    expect(inv?.payload).toMatchObject({
      org_id: "org-xyz",
      kind: "setup_fee",
      status: "paid",
      amount_gbp: "1000.00",
      currency: "GBP",
    });
    expect(expectProcessed(res).actions).toContain("setup_fee_paid");
  });
});

describe("checkout.session.completed — subscription (org flow)", () => {
  it("activates the org and binds the subscription id", async () => {
    const res = await processStripeEvent(
      evt("checkout.session.completed", {
        id: "cs_2",
        metadata: { org_id: "org-xyz", kind: "subscription" },
        customer: "cus_1",
        subscription: "sub_1",
        amount_total: 50_000,
        currency: "gbp",
      }),
    );
    expect(res.status).toBe("processed");

    const act = orgStatusUpdate();
    expect(act?.payload?.status).toBe("active");
    expect(act?.payload?.stripe_subscription_id).toBe("sub_1");
    expect(expectProcessed(res).actions).toContain("subscription_started:sub_1");
  });
});

describe("checkout.session.completed — demo flow (org not yet provisioned)", () => {
  it("routes to the demo-lifecycle handler, not the org path", async () => {
    const res = await processStripeEvent(
      evt("checkout.session.completed", {
        id: "cs_3",
        metadata: { demo_id: "demo-1", kind: "setup_fee" },
        amount_total: 100_000,
        currency: "gbp",
        payment_intent: "pi_3",
      }),
    );
    expect(res.status).toBe("processed");
    expect(demoConfirm).toHaveBeenCalledTimes(1);
    expect(demoConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ demoId: "demo-1", amountGbp: 1000 }),
    );
    // No org-flow writes: there is no org yet.
    expect(orgUpdates()).toHaveLength(0);
    expect(invoiceInserts()).toHaveLength(0);
    expect(expectProcessed(res).actions).toContain("demo_setup_fee_paid:demo-1");
  });
});

// =====================================================================
// invoice.paid / invoice.payment_failed — renewal + dunning
// =====================================================================

describe("invoice.paid", () => {
  it("records a paid £500 subscription invoice against the org", async () => {
    const res = await processStripeEvent(
      evt("invoice.paid", {
        id: "in_1",
        customer: "cus_1",
        amount_paid: 50_000,
        currency: "gbp",
        status_transitions: { paid_at: 1_700_000_000 },
        lines: {
          data: [
            {
              parent: {
                subscription_item_details: { subscription: "sub_1" },
              },
            },
          ],
        },
      }),
    );
    expect(res.status).toBe("processed");

    // Upsert: update-by-stripe_invoice_id, then insert guarded by unique idx.
    expect(
      invoiceUpdates().some((o) =>
        o.eqs.some(([k, v]) => k === "stripe_invoice_id" && v === "in_1"),
      ),
    ).toBe(true);
    const inv = invoiceInserts()[0];
    expect(inv?.payload).toMatchObject({
      org_id: "org-xyz",
      kind: "subscription", // resolved from lines[].parent.subscription
      status: "paid",
      amount_gbp: "500.00",
    });
    expect(expectProcessed(res).actions).toContain("invoice_paid:in_1");
  });
});

describe("invoice.payment_failed", () => {
  it("records a failed invoice but does NOT itself flip org status (that follows the subscription event)", async () => {
    const res = await processStripeEvent(
      evt("invoice.payment_failed", {
        id: "in_2",
        customer: "cus_1",
        amount_due: 50_000,
        currency: "gbp",
      }),
    );
    expect(res.status).toBe("processed");

    expect(
      invoiceUpdates().some(
        (o) =>
          o.payload?.status === "failed" &&
          o.eqs.some(([k, v]) => k === "stripe_invoice_id" && v === "in_2"),
      ),
    ).toBe(true);
    expect(invoiceInserts()[0]?.payload).toMatchObject({ status: "failed" });
    // Suspension is driven by customer.subscription.updated (past_due), not
    // here — so no organizations row is touched by this handler.
    expect(orgUpdates()).toHaveLength(0);
    expect(expectProcessed(res).actions).toContain("invoice_failed:in_2");
  });
});

// =====================================================================
// customer.subscription.updated — the org-state machine
// =====================================================================

describe("customer.subscription.updated — status drives org access state", () => {
  const cases: Array<[string, string | undefined]> = [
    ["active", "active"],
    ["trialing", "active"],
    ["past_due", "suspended"],
    ["unpaid", "suspended"],
    ["canceled", "cancelled"],
    ["incomplete", undefined], // no access grant, no suspension — left as-is
  ];

  for (const [stripeStatus, expectedOrgStatus] of cases) {
    it(`Stripe '${stripeStatus}' → org status '${expectedOrgStatus ?? "(unchanged)"}'`, async () => {
      const res = await processStripeEvent(
        evt("customer.subscription.updated", {
          id: "sub_1",
          customer: "cus_1",
          status: stripeStatus,
          current_period_end: 1_700_000_000,
        }),
      );
      expect(res.status).toBe("processed");
      const upd = orgUpdates()[0];
      expect(upd?.payload?.stripe_subscription_id).toBe("sub_1");
      expect(upd?.payload?.status).toBe(expectedOrgStatus);
      expect(upd?.payload?.next_renewal_at).toBeTruthy();
      expect(expectProcessed(res).actions).toContain(`subscription_synced:${stripeStatus}`);
    });
  }

  it("skips when no org is linked to the Stripe customer", async () => {
    h.cfg.orgRow = null;
    const res = await processStripeEvent(
      evt("customer.subscription.updated", {
        id: "sub_1",
        customer: "cus_unknown",
        status: "active",
      }),
    );
    expect(res.status).toBe("processed");
    expect(expectProcessed(res).actions).toContain("skipped:no_org_for_customer");
    expect(orgUpdates()).toHaveLength(0);
  });
});

// =====================================================================
// customer.subscription.deleted — intentionally NON-destructive
// =====================================================================

describe("customer.subscription.deleted", () => {
  it("records the cancellation but does NOT auto-flip org status (high-blast operator decision)", async () => {
    const res = await processStripeEvent(
      evt("customer.subscription.deleted", {
        id: "sub_1",
        customer: "cus_1",
        status: "canceled",
      }),
    );
    expect(res.status).toBe("processed");
    // The invariant: a deleted subscription must not silently cut off access.
    expect(orgUpdates()).toHaveLength(0);
    expect(expectProcessed(res).actions).toContain("subscription_deleted_recorded");
  });
});

// =====================================================================
// Idempotency for a MONEY event (webhook-retry.test.ts only covers
// customer.created — pin it for invoice.paid too)
// =====================================================================

describe("duplicate delivery of a money event is idempotent", () => {
  it("acks as duplicate and writes NO invoice rows when the event was already processed", async () => {
    h.cfg.insertError = { message: "duplicate key value", code: "23505" };
    h.cfg.reclaimReturns = []; // completed / active lease held elsewhere

    const res = await processStripeEvent(
      evt("invoice.paid", {
        id: "in_dup",
        customer: "cus_1",
        amount_paid: 50_000,
        currency: "gbp",
      }),
    );

    expect(res.status).toBe("duplicate");
    expect(invoiceInserts()).toHaveLength(0);
    expect(invoiceUpdates()).toHaveLength(0);
  });
});
