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
    existingRow: { processed_at: string | null } | null;
    existingLookupError: { message: string } | null;
    dispatchThrows: boolean;
  } = {
    insertError: null,
    existingRow: null,
    existingLookupError: null,
    dispatchThrows: false,
  };

  function from(table: string) {
    return {
      insert: (payload: Record<string, unknown>) => {
        ops.push({ table, op: "insert", payload, eqs: [] });
        return Promise.resolve({ data: null, error: cfg.insertError });
      },
      select: () => {
        const rec: Op = { table, op: "select", eqs: [] };
        ops.push(rec);
        const chain = {
          eq: (k: string, v: unknown) => {
            rec.eqs.push([k, v]);
            return chain;
          },
          maybeSingle: () =>
            Promise.resolve({
              data: cfg.existingRow,
              error: cfg.existingLookupError,
            }),
        };
        return chain;
      },
      update: (payload: Record<string, unknown>) => {
        const rec: Op = { table, op: "update", payload, eqs: [] };
        ops.push(rec);
        const chain = {
          eq: (k: string, v: unknown) => {
            rec.eqs.push([k, v]);
            // The dispatch target is organizations.update — throwing here
            // simulates a transient failure INSIDE the handler.
            if (table === "organizations" && cfg.dispatchThrows) {
              return Promise.reject(new Error("transient db blip"));
            }
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
/** The single billing_events UPDATE — asserted to exist, so callers get a narrowed value. */
function onlyBillingUpdate(): Op {
  const upd = billingUpdates();
  expect(upd).toHaveLength(1);
  const first = upd[0];
  if (!first) throw new Error("expected exactly one billing_events update");
  return first;
}

beforeEach(() => {
  h.ops.length = 0;
  h.cfg.insertError = null;
  h.cfg.existingRow = null;
  h.cfg.existingLookupError = null;
  h.cfg.dispatchThrows = false;
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
    const upd = onlyBillingUpdate();
    expect(upd.payload).toHaveProperty("processed_at");
    expect(upd.payload?.processed_at).toBeTruthy();
    expect(upd.payload?.error_message).toBeNull();
    expect(upd.eqs).toContainEqual(["event_id", EVENT_ID]);
  });
});

describe("failed events remain retryable", () => {
  it("does NOT stamp processed_at when dispatch throws", async () => {
    h.cfg.dispatchThrows = true;
    await expect(processStripeEvent(customerEvent())).rejects.toThrow(
      "transient db blip",
    );
    // The crux: a failed event must not look done, or the retry is refused.
    expect(onlyBillingUpdate().payload).not.toHaveProperty("processed_at");
  });

  it("records the error without falsely signalling success", async () => {
    h.cfg.dispatchThrows = true;
    await expect(processStripeEvent(customerEvent())).rejects.toThrow();
    const upd = onlyBillingUpdate();
    expect(String(upd.payload?.error_message)).toContain("transient db blip");
    expect(upd.payload?.processed_at).toBeUndefined();
  });

  it("rethrows so the route 500s and Stripe schedules the retry", async () => {
    h.cfg.dispatchThrows = true;
    await expect(processStripeEvent(customerEvent())).rejects.toThrow();
  });
});

describe("retried failed event — processed again", () => {
  it("falls through to dispatch when the stored row is unprocessed", async () => {
    // The retry: INSERT collides, but the row was never completed.
    h.cfg.insertError = { message: "duplicate key value", code: "23505" };
    h.cfg.existingRow = { processed_at: null };

    const res = await processStripeEvent(customerEvent());

    expect(res.status).toBe("processed");
    expect(dispatched()).toBe(true); // <- the whole point
  });

  it("a successful retry transitions the event to processed", async () => {
    h.cfg.insertError = { message: "duplicate key value", code: "23505" };
    h.cfg.existingRow = { processed_at: null };

    await processStripeEvent(customerEvent());

    const upd = onlyBillingUpdate();
    expect(upd.payload?.processed_at).toBeTruthy();
    expect(upd.payload?.error_message).toBeNull(); // stale error cleared
  });

  it("checks processed_at on the stored row, keyed by event_id", async () => {
    h.cfg.insertError = { message: "duplicate key value", code: "23505" };
    h.cfg.existingRow = { processed_at: null };
    await processStripeEvent(customerEvent());
    const lookup = h.ops.find(
      (o) => o.table === "billing_events" && o.op === "select",
    );
    expect(lookup).toBeDefined();
    expect(lookup?.eqs).toContainEqual(["event_id", EVENT_ID]);
  });
});

describe("successful duplicates stay idempotent", () => {
  it("short-circuits and does NOT run business logic twice", async () => {
    h.cfg.insertError = { message: "duplicate key value", code: "23505" };
    h.cfg.existingRow = { processed_at: "2026-07-15T00:00:00.000Z" };

    const res = await processStripeEvent(customerEvent());

    expect(res.status).toBe("duplicate");
    expect(dispatched()).toBe(false); // handlers must not re-run
    expect(billingUpdates()).toHaveLength(0); // nothing re-stamped
  });
});

describe("fails safe when the duplicate lookup itself errors", () => {
  it("throws rather than guessing — no drop, no double-run", async () => {
    h.cfg.insertError = { message: "duplicate key value", code: "23505" };
    h.cfg.existingLookupError = { message: "connection reset" };

    await expect(processStripeEvent(customerEvent())).rejects.toThrow(
      /duplicate lookup failed/,
    );
    // Neither outcome was assumed: nothing dispatched, nothing stamped.
    expect(dispatched()).toBe(false);
    expect(billingUpdates()).toHaveLength(0);
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
