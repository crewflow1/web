import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type Stripe from "stripe";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Stripe webhook — in-flight concurrency claim, proved against real Postgres.
 *
 * The defect (after the #350 retry correction): the duplicate-delivery LOSER
 * read `processed_at` and, if NULL, dispatched anyway. Correct for a sequential
 * retry; WRONG under concurrency, where the winner is still mid-dispatch and its
 * row is legitimately processed_at NULL — so the loser read the same NULL and
 * activated the org / wrote the billing row / notified a SECOND time.
 *
 * The fix makes the loser's decision an atomic reclaim UPDATE. This is a
 * database race, so it can only be proved against real Postgres with genuinely
 * concurrent callers (Promise.all).
 *
 * The observable side effect is a `billing_invoices` row: handleCheckoutCompleted
 * with kind=setup_fee inserts exactly one. "Did activation run twice?" is
 * answered by counting those rows, not by inspecting billing_events.
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

const TOKEN = `it-swh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("stripe webhook · in-flight concurrency claim", () => {
  let orgId = "";
  let processStripeEvent: typeof import("@/server/services/stripe-webhook-handler").processStripeEvent;
  let LEASE_MS = 0;

  const freshEventId = () => `evt_${TOKEN}_${Math.random().toString(36).slice(2, 10)}`;

  /** checkout.session.completed for a setup fee → one billing_invoices insert. */
  const checkoutEvent = (eventId: string): Stripe.Event =>
    ({
      id: eventId,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_${eventId}`,
          customer: `cus_${eventId}`,
          metadata: { org_id: orgId, kind: "setup_fee", amount_gbp: "1000" },
        },
      },
    }) as unknown as Stripe.Event;

  const billingInvoiceCount = async () => {
    const res = await db(serviceClient())
      .from("billing_invoices")
      .select("id")
      .eq("org_id", orgId)
      .eq("kind", "setup_fee");
    expect(res.error, res.error?.message).toBeNull();
    return (res.data ?? []).length;
  };

  const eventRow = async (eventId: string) => {
    const res = await db(serviceClient())
      .from("billing_events")
      .select("event_id, processed_at, claimed_at, error_message")
      .eq("event_id", eventId);
    expect(res.error, res.error?.message).toBeNull();
    return (res.data ?? []) as Array<Record<string, unknown>>;
  };

  const setEventRow = async (
    eventId: string,
    patch: Record<string, unknown>,
  ) => {
    const res = await db(serviceClient())
      .from("billing_events")
      .update(patch)
      .eq("event_id", eventId);
    expect(res.error, res.error?.message).toBeNull();
  };

  beforeAll(async () => {
    const svc = db(serviceClient());
    const org = await svc
      .from("organizations")
      .insert({ name: "Stripe Claim Org", slug: `${TOKEN}-org` })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    orgId = org.data?.id as string;
    if (!orgId) throw new Error("failed to create probe org");

    const mod = await import("@/server/services/stripe-webhook-handler");
    processStripeEvent = mod.processStripeEvent;
    LEASE_MS = mod.BILLING_CLAIM_LEASE_MS;
  });

  afterAll(async () => {
    if (orgId) await db(serviceClient()).from("organizations").delete().eq("id", orgId);
  });

  beforeEach(async () => {
    // billing_invoices are org-scoped; clear between tests for clean counts.
    await db(serviceClient()).from("billing_invoices").delete().eq("org_id", orgId);
  });

  // -------------------------------------------------------------------
  // The core race
  // -------------------------------------------------------------------

  it("two SIMULTANEOUS first deliveries → exactly one processing winner", async () => {
    const id = freshEventId();
    const [a, b] = await Promise.all([
      processStripeEvent(checkoutEvent(id)),
      processStripeEvent(checkoutEvent(id)),
    ]);
    const statuses = [a.status, b.status].sort();
    // Exactly one processed; the other acked as duplicate.
    expect(statuses).toEqual(["duplicate", "processed"]);
  });

  it("…the loser creates NO duplicate billing row (activation ran once)", async () => {
    const id = freshEventId();
    await Promise.all([
      processStripeEvent(checkoutEvent(id)),
      processStripeEvent(checkoutEvent(id)),
    ]);
    expect(await billingInvoiceCount()).toBe(1);
  });

  it("…and exactly one billing_events row exists, completed", async () => {
    const id = freshEventId();
    await Promise.all([
      processStripeEvent(checkoutEvent(id)),
      processStripeEvent(checkoutEvent(id)),
    ]);
    const rows = await eventRow(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.processed_at).toBeTruthy();
  });

  it("five simultaneous deliveries still activate exactly once", async () => {
    const id = freshEventId();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => processStripeEvent(checkoutEvent(id))),
    );
    expect(results.filter((r) => r.status === "processed")).toHaveLength(1);
    expect(await billingInvoiceCount()).toBe(1);
  });

  // -------------------------------------------------------------------
  // Completed work is terminal
  // -------------------------------------------------------------------

  it("a completed event is a duplicate on every later delivery", async () => {
    const id = freshEventId();
    const first = await processStripeEvent(checkoutEvent(id));
    expect(first.status).toBe("processed");
    expect(await billingInvoiceCount()).toBe(1);

    const again = await processStripeEvent(checkoutEvent(id));
    expect(again.status).toBe("duplicate");
    expect(await billingInvoiceCount()).toBe(1); // no second activation
  });

  it("a completed event cannot be reclaimed even with an ancient claimed_at", async () => {
    const id = freshEventId();
    await processStripeEvent(checkoutEvent(id));
    // processed_at — not the lease — is what makes it terminal.
    await setEventRow(id, {
      claimed_at: new Date(Date.now() - LEASE_MS * 10).toISOString(),
    });
    const again = await processStripeEvent(checkoutEvent(id));
    expect(again.status).toBe("duplicate");
    expect(await billingInvoiceCount()).toBe(1);
  });

  // -------------------------------------------------------------------
  // Leases + failure recovery
  // -------------------------------------------------------------------

  it("an ACTIVE lease cannot be stolen — the loser runs nothing", async () => {
    const id = freshEventId();
    await processStripeEvent(checkoutEvent(id));
    // Force the row back to in-flight with a fresh lease (a concurrent winner
    // still working) and clear the side effect.
    await db(serviceClient()).from("billing_invoices").delete().eq("org_id", orgId);
    await setEventRow(id, {
      processed_at: null,
      error_message: null,
      claimed_at: new Date().toISOString(),
    });

    const res = await processStripeEvent(checkoutEvent(id));
    expect(res.status).toBe("duplicate");
    expect(await billingInvoiceCount()).toBe(0); // no activation
  });

  it("an EXPIRED lease is reclaimed — an orphaned event recovers", async () => {
    const id = freshEventId();
    await processStripeEvent(checkoutEvent(id));
    await db(serviceClient()).from("billing_invoices").delete().eq("org_id", orgId);
    // A process that claimed and died: unprocessed, no error, lease stale.
    await setEventRow(id, {
      processed_at: null,
      error_message: null,
      claimed_at: new Date(Date.now() - LEASE_MS - 60_000).toISOString(),
    });

    const res = await processStripeEvent(checkoutEvent(id));
    expect(res.status).toBe("processed");
    expect(await billingInvoiceCount()).toBe(1);
    expect(await eventRow(id)).toHaveLength(1); // reclaimed in place
  });

  it("an expired lease is reclaimed by EXACTLY ONE of many concurrent callers", async () => {
    const id = freshEventId();
    await processStripeEvent(checkoutEvent(id));
    await db(serviceClient()).from("billing_invoices").delete().eq("org_id", orgId);
    await setEventRow(id, {
      processed_at: null,
      error_message: null,
      claimed_at: new Date(Date.now() - LEASE_MS - 60_000).toISOString(),
    });

    const results = await Promise.all([
      processStripeEvent(checkoutEvent(id)),
      processStripeEvent(checkoutEvent(id)),
      processStripeEvent(checkoutEvent(id)),
    ]);
    expect(results.filter((r) => r.status === "processed")).toHaveLength(1);
    expect(await billingInvoiceCount()).toBe(1);
  });

  it("a FAILED event is reclaimable immediately — no lease wait", async () => {
    const id = freshEventId();
    await processStripeEvent(checkoutEvent(id));
    await db(serviceClient()).from("billing_invoices").delete().eq("org_id", orgId);
    // markFailed shape: error recorded, processed_at NULL, lease still FRESH.
    await setEventRow(id, {
      processed_at: null,
      error_message: "probe: simulated failure",
      claimed_at: new Date().toISOString(),
    });

    const res = await processStripeEvent(checkoutEvent(id));
    expect(res.status).toBe("processed");
    expect(await billingInvoiceCount()).toBe(1);
  });

  it("a successful retry stamps processed_at and CLEARS the stale error", async () => {
    const id = freshEventId();
    await processStripeEvent(checkoutEvent(id));
    await db(serviceClient()).from("billing_invoices").delete().eq("org_id", orgId);
    await setEventRow(id, {
      processed_at: null,
      error_message: "probe: simulated failure",
      claimed_at: new Date().toISOString(),
    });

    await processStripeEvent(checkoutEvent(id));

    const rows = await eventRow(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.processed_at).toBeTruthy();
    expect(rows[0]?.error_message).toBeNull();
  });

  // -------------------------------------------------------------------
  // Identity + idempotency invariants
  // -------------------------------------------------------------------

  it("event_id uniqueness is still enforced", async () => {
    const id = freshEventId();
    await processStripeEvent(checkoutEvent(id));
    const dupe = await db(serviceClient())
      .from("billing_events")
      .insert({ event_id: id, event_type: "checkout.session.completed", payload: {} })
      .select("id")
      .single();
    expect(dupe.error).not.toBeNull();
    expect(dupe.error?.message ?? "").toMatch(/duplicate|unique/i);
  });

  it("a single normal delivery activates once and records completion metadata", async () => {
    const id = freshEventId();
    const res = await processStripeEvent(checkoutEvent(id));
    expect(res.status).toBe("processed");
    expect(await billingInvoiceCount()).toBe(1);
    const rows = await eventRow(id);
    expect(rows[0]?.processed_at).toBeTruthy();
    expect(rows[0]?.claimed_at).toBeTruthy();
    expect(rows[0]?.error_message).toBeNull();
  });
});
