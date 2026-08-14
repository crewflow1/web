import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac } from "node:crypto";

/**
 * Inbound-email webhook handler — claim → route → hand off (mocked Supabase).
 *
 * The handler reuses the whatsapp_webhook_events claim protocol verbatim over the
 * email ledger, resolves the org by DESTINATION ADDRESS, and hands off to the
 * UNCHANGED processInboundEnquiry core with channel='email'. These behavioural
 * proofs (no real Postgres) pin: a routed delivery hands off with the right shape;
 * an unrouted address is ack-dropped and NEVER reaches the ingestion core; a
 * redelivery folds to a duplicate; and an id-less delivery is rejected untouched.
 */

// ---- Configurable fakes for the two tables + the ingestion core ----
type Res = { data: unknown; error: { message: string; code?: string } | null };

let claimInsertResult: { error: { message: string; code?: string } | null } = { error: null };
let reclaimResult: Res = { data: [{ id: "evt-1" }], error: null };
let routeResult: Res = { data: null, error: null };
const inserted: Record<string, unknown>[] = [];
const updates: Record<string, unknown>[] = [];

function thenable<T>(value: T): PromiseLike<T> & Record<string, unknown> {
  // A resolved-promise stand-in that ALSO carries chain methods, so the same
  // object can be awaited OR chained (matching the handler's update(...).eq(...)).
  return Promise.resolve(value) as unknown as PromiseLike<T> & Record<string, unknown>;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "email_webhook_events") {
        return {
          insert: async (row: Record<string, unknown>) => {
            inserted.push(row);
            return claimInsertResult;
          },
          update: (row: Record<string, unknown>) => {
            updates.push(row);
            // markProcessed/markFailed: update(row).eq(k,v) is awaited → {error:null}.
            // reclaim: update(row).eq().is().or().select() → {data,error}.
            const eqReturn = thenable({ error: null });
            eqReturn.is = () => ({
              or: () => ({ select: async () => reclaimResult }),
            });
            return { eq: () => eqReturn };
          },
        };
      }
      if (table === "email_inbound_routes") {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ maybeSingle: async () => routeResult }) }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

const { processInboundEnquiry, recordAdminActivity } = vi.hoisted(() => ({
  processInboundEnquiry: vi.fn(async () => ({
    enquiry_id: "enq-1",
    lead_id: "lead-1",
    conversation_id: "conv-1",
    textback: { attempted: false, reason: "unsupported_channel" as const },
  })),
  recordAdminActivity: vi.fn(async () => undefined),
}));
vi.mock("@/server/services/receptionist", () => ({ processInboundEnquiry }));
vi.mock("@/server/services/hq-audit", () => ({ recordAdminActivity }));

import {
  processInboundEmailPayload,
  isInboundEmailLive,
} from "@/server/services/email-webhook-handler";

const body = (o: Record<string, unknown>) => JSON.stringify(o);

beforeEach(() => {
  claimInsertResult = { error: null };
  reclaimResult = { data: [{ id: "evt-1" }], error: null };
  routeResult = { data: { org_id: "org-A" }, error: null };
  inserted.length = 0;
  updates.length = 0;
  processInboundEnquiry.mockClear();
  recordAdminActivity.mockClear();
  vi.unstubAllEnvs();
});
afterEach(() => vi.unstubAllEnvs());

describe("processInboundEmailPayload — parse → enquiry (routed, claim won)", () => {
  it("hands off to the UNCHANGED core with channel='email' and the right shape", async () => {
    const res = await processInboundEmailPayload(
      body({
        from: "Cust <cust@mail.com>",
        to: "leads@org-a.com",
        subject: "Leaking tap",
        text: "Kitchen tap leaking",
        message_id: "<m-1@mail.com>",
        timestamp: 1700000000,
        attachments: [{ filename: "photo.jpg", content_type: "image/jpeg", size: 10 }],
      }),
    );
    expect(res).toMatchObject({ messages: 1, dispatched: 1, duplicates: 0, unrouted: 0, rejected: 0, failed: 0 });
    expect(processInboundEnquiry).toHaveBeenCalledTimes(1);
    expect(processInboundEnquiry).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: "org-A",
        channel: "email",
        caller: "cust@mail.com",
        dedup_key: "<m-1@mail.com>",
        provider_message_id: "<m-1@mail.com>",
        has_media: true,
      }),
    );
    // Claim written with the resolved org + addresses; then markProcessed.
    expect(inserted[0]).toMatchObject({ event_key: "email:<m-1@mail.com>", org_id: "org-A", to_address: "leads@org-a.com" });
    expect(updates.some((u) => "processed_at" in u)).toBe(true);
  });

  it("returns null on an unparseable body (nothing claimed, nothing dispatched)", async () => {
    const res = await processInboundEmailPayload("not json");
    expect(res).toBeNull();
    expect(inserted).toHaveLength(0);
    expect(processInboundEnquiry).not.toHaveBeenCalled();
  });
});

describe("org routing — unrouted destination is ack-dropped, never guessed", () => {
  it("no active route → ack-drop: HQ audit + processed, ingestion core NOT reached", async () => {
    routeResult = { data: null, error: null }; // no route for this address
    const res = await processInboundEmailPayload(
      body({ from: "a@b.com", to: "nobody@unknown.com", message_id: "<u-1@b.com>", text: "hi" }),
    );
    expect(res).toMatchObject({ dispatched: 0, unrouted: 1 });
    expect(processInboundEnquiry).not.toHaveBeenCalled();
    expect(recordAdminActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "email.unrouted_address" }),
    );
    // The unrouted event is still CLAIMED (org_id null) and marked processed.
    expect(inserted[0]).toMatchObject({ event_key: "email:<u-1@b.com>", org_id: null });
    expect(updates.some((u) => "processed_at" in u)).toBe(true);
  });

  it("a route read ERROR fails closed to unrouted (never processes against a guess)", async () => {
    routeResult = { data: null, error: { message: "boom" } };
    const res = await processInboundEmailPayload(
      body({ from: "a@b.com", to: "leads@org-a.com", message_id: "<e-1@b.com>", text: "hi" }),
    );
    expect(res).toMatchObject({ unrouted: 1, dispatched: 0 });
    expect(processInboundEnquiry).not.toHaveBeenCalled();
  });
});

describe("idempotency — a redelivery folds to a duplicate", () => {
  it("claim insert collides (23505) and the reclaim wins nothing → duplicate, no re-dispatch", async () => {
    claimInsertResult = { error: { message: "duplicate key value", code: "23505" } };
    reclaimResult = { data: [], error: null }; // already processed / active lease
    const res = await processInboundEmailPayload(
      body({ from: "a@b.com", to: "leads@org-a.com", message_id: "<dup-1@b.com>", text: "hi" }),
    );
    expect(res).toMatchObject({ duplicates: 1, dispatched: 0 });
    expect(processInboundEnquiry).not.toHaveBeenCalled();
  });

  it("a reclaim that WINS a stale/failed row re-dispatches (never a silent drop)", async () => {
    claimInsertResult = { error: { message: "duplicate key value", code: "23505" } };
    reclaimResult = { data: [{ id: "evt-x" }], error: null };
    const res = await processInboundEmailPayload(
      body({ from: "a@b.com", to: "leads@org-a.com", message_id: "<re-1@b.com>", text: "hi" }),
    );
    expect(res).toMatchObject({ dispatched: 1, duplicates: 0 });
    expect(processInboundEnquiry).toHaveBeenCalledTimes(1);
  });
});

describe("rejection — an id-less delivery cannot be deduped", () => {
  it("no message id → rejected, nothing claimed, ingestion core NOT reached", async () => {
    const res = await processInboundEmailPayload(
      body({ from: "a@b.com", to: "leads@org-a.com", text: "hi" }),
    );
    expect(res).toMatchObject({ rejected: 1, dispatched: 0 });
    expect(inserted).toHaveLength(0);
    expect(processInboundEnquiry).not.toHaveBeenCalled();
  });
});

describe("isInboundEmailLive — two-switch, dark by default", () => {
  const SECRET = "s";
  const sign = (raw: string) => "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  it("false unless BOTH the flag AND the secret are set", () => {
    expect(isInboundEmailLive()).toBe(false); // both unset
    vi.stubEnv("NEXT_PUBLIC_FEATURE_INBOUND_EMAIL", "true");
    expect(isInboundEmailLive()).toBe(false); // flag only
    vi.stubEnv("NEXT_PUBLIC_FEATURE_INBOUND_EMAIL", "false");
    vi.stubEnv("INBOUND_EMAIL_WEBHOOK_SECRET", SECRET);
    expect(isInboundEmailLive()).toBe(false); // secret only
    vi.stubEnv("NEXT_PUBLIC_FEATURE_INBOUND_EMAIL", "true");
    expect(isInboundEmailLive()).toBe(true); // both
    void sign; // signature scheme proven in the adapter test
  });
});
