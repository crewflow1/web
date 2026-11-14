import { describe, it, expect, vi, beforeEach } from "vitest";
import type Stripe from "stripe";

/**
 * Stripe webhook — at-least-once retry behaviour.
 *
 * The bug: `markProcessed` stamped `processed_at` on BOTH the success and the
 * error path, and the duplicate branch short-circuited on row EXISTENCE. So:
 *
 *   dispatch throws → processed_at stamped → route 500s → Stripe retries →
 *   INSERT collides (23505) → "duplicate" → handler never runs. Event lost.
 *
 * One transient blip inside a handler permanently dropped the event: for
 * checkout.session.completed that means the tenant paid, their org never
 * activated, no billing_invoices row was written and no notification fired —
 * with the only trace in billing_events.error_message. That is CrewFlow's own
 * revenue capture.
 *
 * These tests EXECUTE the real handler against a chainable Supabase mock,
 * following __tests__/job-documents/service.test.ts. That matters here: the
 * existing __tests__/stripe/contract.test.ts asserts `/status: "duplicate"/` on
 * the SOURCE TEXT and never runs the handler, so it stayed green throughout the
 * bug and would stay green if the fix were reverted. A source pin cannot
 * distinguish "returns duplicate when genuinely processed" from "returns
 * duplicate whenever a row exists" — that distinction IS the bug.
 *
 * `customer.created` is the dispatch target: orgIdFromEvent resolves org_id
 * straight from metadata (no DB round trip) and handleCustomerUpsert performs
 * exactly ONE observable write (organizations.update), so "did the business
 * logic run?" is a clean, unambiguous signal.
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
    insertError: { message: string; code?: string } | null;
    // The row the atomic reclaim UPDATE ... RETURNING resolves to: a non-empty
    // array = "I reclaimed it → dispatch"; [] = "completed or active lease →
    // skip". This is what the post-#350 concurrency claim reads instead of a
    // separate processed_at select.
    reclaimReturns: Array<{ id: string }>;
    reclaimError: { message: string } | null;
    dispatchThrows: boolean;
    /**
     * The dispatch write RETURNS an error instead of throwing — which is how the
     * Supabase client actually fails (PostgREST errors are returned). The
     * `dispatchThrows` switch above models a rejected promise, which a real
     * write failure never produces; this is the realistic fault.
     */
    orgWriteReturnsError: { message: string; code?: string } | null;
    /** What the billing_events `processed_at` state read resolves to. */
    eventState: { data: { processed_at: string | null } | null; error: { message: string } | null };
    /** What the organizations-by-stripe-customer lookup resolves to. */
    orgLookup: { data: { id: string } | null; error: { message: string } | null };
  } = {
    insertError: null,
    reclaimReturns: [],
    reclaimError: null,
    dispatchThrows: false,
    orgWriteReturnsError: null,
    eventState: { data: { processed_at: null }, error: null },
    orgLookup: { data: { id: "org-1" }, error: null },
  };

  function from(table: string) {
    return {
      select: () => {
        const rec: Op = { table, op: "select", eqs: [] };
        ops.push(rec);
        const result = () =>
          Promise.resolve(
            table === "billing_events"
              ? cfg.eventState
              : table === "organizations"
                ? cfg.orgLookup
                : { data: null, error: null },
          );
        const q = {
          eq: (k: string, v: unknown) => {
            rec.eqs.push([k, v]);
            return q;
          },
          limit: () => Promise.resolve({ data: [], error: null }),
          maybeSingle: result,
        };
        return q;
      },
      insert: (payload: Record<string, unknown>) => {
        ops.push({ table, op: "insert", payload, eqs: [] });
        return Promise.resolve({ data: null, error: cfg.insertError });
      },
      update: (payload: Record<string, unknown>) => {
        const rec: Op = { table, op: "update", payload, eqs: [] };
        ops.push(rec);
        // The billing_events reclaim: .update().eq().is().or().select().
        // The completion/failure writes: .update().eq() (thenable).
        const isReclaim = "claimed_at" in payload && "error_message" in payload;
        const chain = {
          eq: (k: string, v: unknown) => {
            rec.eqs.push([k, v]);
            if (table === "organizations" && cfg.dispatchThrows) {
              // The dispatch target — simulate a transient in-handler failure.
              return Promise.reject(new Error("transient db blip"));
            }
            if (isReclaim) {
              // Continue the reclaim chain: .is().or().select().
              const reclaimChain = {
                is: () => reclaimChain,
                or: () => reclaimChain,
                select: () =>
                  Promise.resolve({
                    data: cfg.reclaimReturns,
                    error: cfg.reclaimError,
                  }),
              };
              return reclaimChain;
            }
            if (table === "organizations" && cfg.orgWriteReturnsError) {
              // The realistic failure: resolved, with an error member.
              return Promise.resolve({ error: cfg.orgWriteReturnsError });
            }
            // markProcessed / markFailed terminal update.
            return Promise.resolve({ error: null });
          },
        };
        return chain;
      },
    };
  }

  return { ops, cfg, createAdminClient: () => ({ from }) };
});

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: h.createAdminClient,
}));

const { processStripeEvent } = await import(
  "@/server/services/stripe-webhook-handler"
);

const EVENT_ID = "evt_retry_1";

function customerEvent(): Stripe.Event {
  return {
    id: EVENT_ID,
    type: "customer.created",
    data: {
      object: {
        id: "cus_123",
        email: "owner@example.com",
        metadata: { org_id: "org-1" },
      },
    },
  } as unknown as Stripe.Event;
}

/** Did the business logic actually run? */
const dispatched = () => h.ops.some((o) => o.table === "organizations");
/** billing_events UPDATEs, in order. */
const billingUpdates = () =>
  h.ops.filter((o) => o.table === "billing_events" && o.op === "update");
/** The reclaim UPDATE (has both claimed_at + error_message), if any. */
const reclaimUpdate = () =>
  billingUpdates().find(
    (o) => o.payload && "claimed_at" in o.payload && "error_message" in o.payload,
  );
/** The terminal completion/failure UPDATE (markProcessed / markFailed). */
function terminalBillingUpdate(): Op {
  const term = billingUpdates().filter((o) => o !== reclaimUpdate());
  expect(term).toHaveLength(1);
  const first = term[0];
  if (!first) throw new Error("expected exactly one terminal billing_events update");
  return first;
}

beforeEach(() => {
  h.ops.length = 0;
  h.cfg.insertError = null;
  h.cfg.reclaimReturns = [];
  h.cfg.reclaimError = null;
  h.cfg.dispatchThrows = false;
  h.cfg.orgWriteReturnsError = null;
  h.cfg.eventState = { data: { processed_at: null }, error: null };
  h.cfg.orgLookup = { data: { id: "org-1" }, error: null };
});

// =====================================================================

describe("first delivery — success", () => {
  it("dispatches and marks the event processed", async () => {
    const res = await processStripeEvent(customerEvent());
    expect(res.status).toBe("processed");
    expect(dispatched()).toBe(true);
  });

  it("stamps processed_at and clears any error", async () => {
    await processStripeEvent(customerEvent());
    const upd = terminalBillingUpdate();
    expect(upd.payload).toHaveProperty("processed_at");
    expect(upd.payload?.processed_at).toBeTruthy();
    expect(upd.payload?.error_message).toBeNull();
    expect(upd.eqs).toContainEqual(["event_id", EVENT_ID]);
  });

  it("stamps claimed_at on the initial insert (the atomic first claim)", async () => {
    await processStripeEvent(customerEvent());
    const ins = h.ops.find((o) => o.table === "billing_events" && o.op === "insert");
    expect(ins?.payload).toHaveProperty("claimed_at");
    expect(ins?.payload?.claimed_at).toBeTruthy();
  });
});

describe("failed events remain retryable", () => {
  it("does NOT stamp processed_at when dispatch throws", async () => {
    h.cfg.dispatchThrows = true;
    await expect(processStripeEvent(customerEvent())).rejects.toThrow(
      "transient db blip",
    );
    // The crux: a failed event must not look done, or the retry is refused.
    expect(terminalBillingUpdate().payload).not.toHaveProperty("processed_at");
  });

  it("records the error without falsely signalling success", async () => {
    h.cfg.dispatchThrows = true;
    await expect(processStripeEvent(customerEvent())).rejects.toThrow();
    const upd = terminalBillingUpdate();
    expect(String(upd.payload?.error_message)).toContain("transient db blip");
    expect(upd.payload?.processed_at).toBeUndefined();
  });

  it("rethrows so the route 500s and Stripe schedules the retry", async () => {
    h.cfg.dispatchThrows = true;
    await expect(processStripeEvent(customerEvent())).rejects.toThrow();
  });
});

describe("retried / orphaned event — reclaimed and processed again", () => {
  it("dispatches when the atomic reclaim WINS (row returned)", async () => {
    // INSERT collides, but the reclaim UPDATE matched a releasable row
    // (failed, or lease-expired) and returned it.
    h.cfg.insertError = { message: "duplicate key value", code: "23505" };
    h.cfg.reclaimReturns = [{ id: "be-1" }];

    const res = await processStripeEvent(customerEvent());

    expect(res.status).toBe("processed");
    expect(dispatched()).toBe(true); // <- the whole point
  });

  it("a successful retry transitions the event to processed", async () => {
    h.cfg.insertError = { message: "duplicate key value", code: "23505" };
    h.cfg.reclaimReturns = [{ id: "be-1" }];

    await processStripeEvent(customerEvent());

    const upd = terminalBillingUpdate();
    expect(upd.payload?.processed_at).toBeTruthy();
    expect(upd.payload?.error_message).toBeNull(); // stale error cleared
  });

  it("reclaims atomically (UPDATE ... RETURNING), never read-then-act", async () => {
    h.cfg.insertError = { message: "duplicate key value", code: "23505" };
    h.cfg.reclaimReturns = [{ id: "be-1" }];
    await processStripeEvent(customerEvent());
    // The claim is an UPDATE keyed by event_id — no prior SELECT of the row.
    const reclaim = reclaimUpdate();
    expect(reclaim).toBeDefined();
    expect(reclaim?.eqs).toContainEqual(["event_id", EVENT_ID]);
    expect(h.ops.some((o) => o.op === "select")).toBe(false);
  });
});

describe("concurrent loser / completed event — stays idempotent", () => {
  it("COMPLETED event: short-circuits as 'duplicate' and does NOT run business logic", async () => {
    // Reclaim returns NO row and the event is stamped processed.
    h.cfg.insertError = { message: "duplicate key value", code: "23505" };
    h.cfg.reclaimReturns = [];
    h.cfg.eventState = { data: { processed_at: "2026-11-01T10:00:00Z" }, error: null };

    const res = await processStripeEvent(customerEvent());

    expect(res.status).toBe("duplicate");
    expect(dispatched()).toBe(false); // handlers must not re-run
    // Only the reclaim attempt itself; no terminal stamp.
    expect(billingUpdates().filter((o) => o !== reclaimUpdate())).toHaveLength(0);
  });

  it("LIVE CLAIM held by another delivery: runs nothing, but answers 'in_flight' — NOT 'duplicate'", async () => {
    // Reclaim returns NO row and the event is NOT processed: another delivery
    // holds an active lease. Acking this as "duplicate" (HTTP 200) told Stripe
    // the event was delivered; if the in-flight attempt was then killed before
    // it could record a failure, nothing ever retried it — permanently stuck.
    h.cfg.insertError = { message: "duplicate key value", code: "23505" };
    h.cfg.reclaimReturns = [];
    h.cfg.eventState = { data: { processed_at: null }, error: null };

    const res = await processStripeEvent(customerEvent());

    expect(res.status).toBe("in_flight");
    expect(dispatched()).toBe(false); // still runs NOTHING — the concurrency guarantee is intact
    expect(billingUpdates().filter((o) => o !== reclaimUpdate())).toHaveLength(0);
  });

  it("cannot tell completed from in-flight (state read fails) → throws, never a false 'delivered'", async () => {
    h.cfg.insertError = { message: "duplicate key value", code: "23505" };
    h.cfg.reclaimReturns = [];
    h.cfg.eventState = { data: null, error: { message: "connection reset" } };

    await expect(processStripeEvent(customerEvent())).rejects.toThrow(/state read failed/);
    expect(dispatched()).toBe(false);
  });
});

describe("FAULT INJECTION — a handler write that fails the way Supabase really fails", () => {
  it("a RETURNED write error (not a throw) leaves the event retryable — it is NOT stamped processed", async () => {
    // PostgREST returns { error }; it does not reject. The handlers used to
    // discard that result, so this exact fault ended with processed_at stamped
    // and a 200 to Stripe: the org was never updated and the event never retried.
    h.cfg.orgWriteReturnsError = { code: "57014", message: "canceling statement due to statement timeout" };

    await expect(processStripeEvent(customerEvent())).rejects.toThrow(
      /organizations customer-sync update failed: canceling statement due to statement timeout/,
    );

    const upd = terminalBillingUpdate();
    expect(upd.payload?.processed_at, "must NOT look done").toBeUndefined();
    expect(String(upd.payload?.error_message)).toContain("statement timeout");
  });

  it("the org lookup FAILING is not 'no org for this customer' — the event is not dropped", async () => {
    // customer.subscription.deleted resolves its org by stripe_customer_id. A
    // failed read used to return null → "skipped:no_org_for_customer" → stamped
    // processed → the cancellation was lost and the tenant kept access.
    h.cfg.orgLookup = { data: null, error: { message: "upstream connect error" } };
    const deleted = {
      id: "evt_sub_deleted_1",
      type: "customer.subscription.deleted",
      created: 1_800_000_000,
      data: { object: { id: "sub_1", customer: "cus_123", status: "canceled" } },
    } as unknown as Stripe.Event;

    await expect(processStripeEvent(deleted)).rejects.toThrow(
      /organizations lookup by stripe_customer_id failed/,
    );
    // Nothing was stamped terminal anywhere.
    expect(
      billingUpdates().some((o) => o.payload && "processed_at" in o.payload),
    ).toBe(false);
  });

  it("a lookup that SUCCEEDS and finds no org is still a deliberate skip (processed)", async () => {
    h.cfg.orgLookup = { data: null, error: null };
    const deleted = {
      id: "evt_sub_deleted_2",
      type: "customer.subscription.deleted",
      created: 1_800_000_000,
      data: { object: { id: "sub_1", customer: "cus_unknown", status: "canceled" } },
    } as unknown as Stripe.Event;

    const res = await processStripeEvent(deleted);
    expect(res.status).toBe("processed");
    expect(res).toMatchObject({ actions: ["skipped:no_org_for_customer"] });
  });
});

describe("fails safe when the reclaim itself errors", () => {
  it("throws rather than guessing — no drop, no double-run", async () => {
    h.cfg.insertError = { message: "duplicate key value", code: "23505" };
    h.cfg.reclaimError = { message: "connection reset" };

    await expect(processStripeEvent(customerEvent())).rejects.toThrow(
      /reclaim failed/,
    );
    // Neither outcome was assumed: nothing dispatched, no terminal stamp. (The
    // reclaim UPDATE itself was attempted — that's the op that errored.)
    expect(dispatched()).toBe(false);
    expect(billingUpdates().filter((o) => o !== reclaimUpdate())).toHaveLength(0);
  });
});

describe("non-duplicate insert errors still surface", () => {
  it("throws so Stripe retries, without dispatching", async () => {
    h.cfg.insertError = { message: "some other db error", code: "42P01" };
    await expect(processStripeEvent(customerEvent())).rejects.toThrow(
      /billing_events insert failed/,
    );
    expect(dispatched()).toBe(false);
  });
});
