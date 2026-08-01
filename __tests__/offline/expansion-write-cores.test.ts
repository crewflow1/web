import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  enqueue,
  listForPartition,
  clearAll,
} from "@/lib/offline/write-queue";
import type { OrgContext } from "@/server/auth/session";

/**
 * Train 5 — the two new offline verticals, exercised for REAL (not source
 * pins): the queue's handling of their payloads, the dispatch refusals, and —
 * against a scripted Supabase mock — the write cores' duplicate and RECOVERY
 * protocols, which are the load-bearing novelty of this train:
 *
 *   snag.create              one-statement create, diary-shaped: 23505 →
 *                            org-pinned lookup → duplicate.
 *   material_request.create  TWO-statement create (header + lines). The replay
 *                            protocol is key-first with line recovery; every
 *                            branch of it is proven here, including the two
 *                            that would be silent data loss if wrong:
 *                              - a number race must be RETRY, never "duplicate"
 *                                (a green tick on a request that was never
 *                                written);
 *                              - a stranded header (crash between statements)
 *                                must get its lines on replay, not a
 *                                "already recorded" that loses the ask.
 *
 * The DB-level halves (the unique indexes actually firing under RLS) are in
 * __tests__/integration/rls/offline-write-expansion.test.ts.
 */

// ── mocks ────────────────────────────────────────────────────────────────────
const h = vi.hoisted(() => {
  type PgErr = { message: string; code?: string } | null;
  type Insert = { table: string; rows: unknown };
  type Read = { table: string; eqs: Array<[string, unknown]> };
  const state = {
    inserts: [] as Insert[],
    reads: [] as Read[],
    rpcs: [] as Array<{ fn: string; args: Record<string, unknown> }>,
    /** Scripted responses, consumed in call order per channel. */
    script: {
      reads: new Map<string, Array<{ data: unknown; error: PgErr }>>(),
      inserts: new Map<string, Array<{ error: PgErr }>>(),
      rpc: [] as Array<{ data: unknown; error: PgErr }>,
    },
    createClientCalls: 0,
  };
  const nextRead = (table: string) => {
    const q = state.script.reads.get(table);
    if (!q || q.length === 0) throw new Error(`unscripted read on ${table}`);
    return q.shift()!;
  };
  const nextInsert = (table: string) => {
    const q = state.script.inserts.get(table);
    if (!q || q.length === 0) throw new Error(`unscripted insert on ${table}`);
    return q.shift()!;
  };
  const client = {
    from(table: string) {
      const read: Read = { table, eqs: [] };
      const chain = {
        select: () => chain,
        eq: (k: string, v: unknown) => {
          read.eqs.push([k, v]);
          return chain;
        },
        maybeSingle: async () => {
          state.reads.push(read);
          return nextRead(table);
        },
        limit: async () => {
          state.reads.push(read);
          return nextRead(table);
        },
        insert: async (rows: unknown) => {
          state.inserts.push({ table, rows });
          return nextInsert(table);
        },
      };
      return chain;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      state.rpcs.push({ fn, args });
      const next = state.script.rpc.shift();
      if (!next) throw new Error(`unscripted rpc ${fn}`);
      return next;
    },
  };
  return { state, client };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    h.state.createClientCalls += 1;
    return h.client;
  },
}));

const auditCalls = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/server/services/hq-audit", () => ({
  recordAdminActivity: async (args: Record<string, unknown>) => {
    auditCalls.calls.push(args);
  },
}));

import {
  createSnagRecord,
  dispatchOfflineWrite,
} from "@/server/services/offline-writes";
import { createMaterialRequestDraftRecord } from "@/server/services/material-request-writes";

const ctx = (orgId: string) =>
  ({
    membership: { org_id: orgId, role: "staff" },
    org: {
      id: orgId,
      name: "Org",
      slug: "org",
      status: "active",
      plan: "trial",
      trial_ends_at: null,
      created_at: "2026-01-01",
      onboarding_state: {},
    },
  }) as OrgContext;
const user = { id: "user-1", email: "a@b.test" };

const scriptReads = (table: string, ...res: Array<{ data: unknown; error: unknown }>) =>
  h.state.script.reads.set(
    table,
    res as Array<{ data: unknown; error: { message: string; code?: string } | null }>,
  );
const scriptInserts = (table: string, ...res: Array<{ error: unknown }>) =>
  h.state.script.inserts.set(
    table,
    res as Array<{ error: { message: string; code?: string } | null }>,
  );

beforeEach(async () => {
  await clearAll();
  h.state.inserts.length = 0;
  h.state.reads.length = 0;
  h.state.rpcs.length = 0;
  h.state.script.reads.clear();
  h.state.script.inserts.clear();
  h.state.script.rpc.length = 0;
  h.state.createClientCalls = 0;
  auditCalls.calls.length = 0;
});

// ── the queue accepts (and strips) the new kinds' payloads ───────────────────
describe("write queue — the new kinds' payloads", () => {
  it("snag.create: unknown keys are STRIPPED before storage (nothing rides in)", async () => {
    const res = await enqueue({
      userId: "u1",
      orgId: "o1",
      kind: "snag.create",
      payload: {
        title: "Cracked tile",
        trade: "Tiling",
        access_token: "secret", // must never reach IndexedDB
        status: "verified", // must never be client-settable
      },
    });
    expect(res.ok).toBe(true);
    const [item] = await listForPartition("u1", "o1");
    // priority: "medium" is the schema's own default; the point is that the
    // token and the status are GONE and the stored value is the PARSED one.
    expect(item!.payload).toEqual({
      title: "Cracked tile",
      trade: "Tiling",
      priority: "medium",
    });
  });

  it("material_request.create: lines are validated + coerced; extras stripped", async () => {
    const res = await enqueue({
      userId: "u1",
      orgId: "o1",
      kind: "material_request.create",
      payload: {
        priority: "urgent",
        lines: [{ description: "Cement 25kg", qty: "20", unit: "bag", token: "x" }],
        signedUrl: "https://leak.example",
      },
    });
    expect(res.ok).toBe(true);
    const [item] = await listForPartition("u1", "o1");
    expect(item!.payload).toEqual({
      priority: "urgent",
      lines: [{ description: "Cement 25kg", qty: 20, unit: "bag" }],
    });
  });

  it("refuses an invalid payload for each new kind rather than storing junk", async () => {
    const noTitle = await enqueue({
      userId: "u1",
      orgId: "o1",
      kind: "snag.create",
      payload: { description: "no title" },
    });
    expect(noTitle).toEqual({ ok: false, error: "invalid_payload" });
    const noLines = await enqueue({
      userId: "u1",
      orgId: "o1",
      kind: "material_request.create",
      payload: { notes: "no lines" },
    });
    expect(noLines).toEqual({ ok: false, error: "invalid_payload" });
  });

  it("the idempotency key is minted ONCE at authoring and persisted verbatim", async () => {
    const res = await enqueue({
      userId: "u1",
      orgId: "o1",
      kind: "snag.create",
      payload: { title: "t" },
    });
    if (!res.ok) throw new Error("enqueue failed");
    const [stored] = await listForPartition("u1", "o1");
    expect(stored!.clientKey).toBe(res.item.clientKey);
    expect(stored!.clientKey.length).toBeGreaterThan(0);
  });
});

// ── dispatch refusals (hermetic — refused before any DB client exists) ───────
describe("dispatch — the new kinds are refused exactly like the diary", () => {
  it("org_mismatch: authored for org A, org B active → REFUSED, never re-homed", async () => {
    for (const kind of ["snag.create", "material_request.create"]) {
      const out = await dispatchOfflineWrite({
        ctx: ctx("org-B"),
        user,
        item: {
          clientKey: "k-1",
          kind,
          orgId: "org-A",
          payload:
            kind === "snag.create"
              ? { title: "t" }
              : { lines: [{ description: "Cement", qty: 1 }] },
          authoredAt: "2026-07-31T16:02:00.000Z",
        },
      });
      expect(out, kind).toEqual({ status: "rejected", reason: "org_mismatch" });
    }
    // the refusal happened before any database access
    expect(h.state.createClientCalls).toBe(0);
  });

  it("invalid payload for a valid kind → rejected before any write", async () => {
    const out = await dispatchOfflineWrite({
      ctx: ctx("org-A"),
      user,
      item: {
        clientKey: "k-1",
        kind: "material_request.create",
        orgId: "org-A",
        payload: { lines: [] }, // at least one line
        authoredAt: "2026-07-31T16:02:00.000Z",
      },
    });
    expect(out).toEqual({ status: "rejected", reason: "invalid_payload" });
    expect(h.state.createClientCalls).toBe(0);
  });
});

// ── snag core ────────────────────────────────────────────────────────────────
describe("createSnagRecord — the shared snag write core", () => {
  it("accepted: pins org + reporter + status 'open', persists the client key, audits with offline provenance", async () => {
    scriptInserts("snags", { error: null });
    const out = await createSnagRecord({
      ctx: ctx("org-A"),
      user,
      input: { title: "Cracked tile", trade: "Tiling", priority: "high" },
      clientKey: "key-1",
      offlineAuthoredAt: "2026-07-31T16:02:00.000Z",
    });
    expect(out.status).toBe("accepted");
    const row = h.state.inserts[0]!.rows as Record<string, unknown>;
    expect(h.state.inserts[0]!.table).toBe("snags");
    expect(row.org_id).toBe("org-A"); // session org, never the payload's
    expect(row.reported_by).toBe("user-1"); // session user
    expect(row.status).toBe("open"); // born open — never from the payload
    expect(row.client_write_key).toBe("key-1"); // the queue's key, verbatim
    expect(row.offline_authored_at).toBe("2026-07-31T16:02:00.000Z");
    expect(auditCalls.calls).toHaveLength(1);
    expect(auditCalls.calls[0]!.action).toBe("snag.created");
    expect((auditCalls.calls[0]!.metadata as Record<string, unknown>).offline).toBe(true);
  });

  it("duplicate: 23505 → org-pinned lookup → the EXISTING row id, no second write", async () => {
    scriptInserts("snags", { error: { message: "dup", code: "23505" } });
    scriptReads("snags", { data: { id: "snag-1" }, error: null });
    const out = await createSnagRecord({
      ctx: ctx("org-A"),
      user,
      input: { title: "Cracked tile" },
      clientKey: "key-1",
    });
    expect(out).toEqual({ status: "duplicate", id: "snag-1" });
    // the lookup was pinned to the active org AND the key
    const lookup = h.state.reads.find((r) => r.table === "snags");
    expect(lookup!.eqs).toContainEqual(["org_id", "org-A"]);
    expect(lookup!.eqs).toContainEqual(["client_write_key", "key-1"]);
    expect(auditCalls.calls).toHaveLength(0); // a duplicate is not re-audited
  });

  it("the duplicate lookup's OWN failure is a RETRY, never a rejection", async () => {
    scriptInserts("snags", { error: { message: "dup", code: "23505" } });
    scriptReads("snags", { data: null, error: { message: "blip", code: "XX000" } });
    const out = await createSnagRecord({
      ctx: ctx("org-A"),
      user,
      input: { title: "t" },
      clientKey: "key-1",
    });
    expect(out.status).toBe("retry");
  });

  it("cross-org job → job_missing, before any insert", async () => {
    scriptReads("jobs", { data: null, error: null }); // not in the ACTIVE org
    const out = await createSnagRecord({
      ctx: ctx("org-A"),
      user,
      input: { title: "t", job_id: "11111111-1111-4111-8111-111111111111" },
      clientKey: "key-1",
    });
    expect(out).toEqual({ status: "rejected", reason: "job_missing" });
    expect(h.state.inserts).toHaveLength(0);
  });

  it("an assignee who is not a member of the ACTIVE org → assignee_missing", async () => {
    scriptReads("memberships", { data: null, error: null });
    const out = await createSnagRecord({
      ctx: ctx("org-A"),
      user,
      input: { title: "t", assigned_to: "22222222-2222-4222-8222-222222222222" },
      clientKey: "key-1",
    });
    expect(out).toEqual({ status: "rejected", reason: "assignee_missing" });
    expect(h.state.inserts).toHaveLength(0);
    const lookup = h.state.reads.find((r) => r.table === "memberships");
    expect(lookup!.eqs).toContainEqual(["org_id", "org-A"]);
  });

  it("an unclassified insert failure is a RETRY — content is never discarded", async () => {
    scriptInserts("snags", { error: { message: "boom", code: "57014" } });
    const out = await createSnagRecord({
      ctx: ctx("org-A"),
      user,
      input: { title: "t" },
      clientKey: "key-1",
    });
    expect(out.status).toBe("retry");
  });
});

// ── material request core ────────────────────────────────────────────────────
const MR_INPUT = {
  priority: "normal" as const,
  lines: [
    { description: "Cement 25kg", qty: 20, unit: "bag" },
    { description: "Sharp sand", qty: 2, unit: "t" },
  ],
};

describe("createMaterialRequestDraftRecord — key-first with line recovery", () => {
  it("fresh write: number allocated server-side, header pinned to the session, lines in order", async () => {
    scriptReads("material_requests", { data: null, error: null }); // key unknown
    h.state.script.rpc.push({ data: "MR-0007", error: null });
    scriptInserts("material_requests", { error: null });
    scriptInserts("material_request_lines", { error: null });

    const out = await createMaterialRequestDraftRecord({
      ctx: ctx("org-A"),
      user,
      input: MR_INPUT,
      clientKey: "key-1",
      offlineAuthoredAt: "2026-07-31T16:02:00.000Z",
    });
    expect(out.status).toBe("accepted");

    expect(h.state.rpcs).toEqual([
      { fn: "next_material_request_number", args: { target_org: "org-A" } },
    ]);
    const header = h.state.inserts.find((i) => i.table === "material_requests")!
      .rows as Record<string, unknown>;
    expect(header.org_id).toBe("org-A");
    expect(header.status).toBe("draft"); // DRAFT ONLY — never submitted from here
    expect(header.number).toBe("MR-0007");
    expect(header.requested_by).toBe("user-1");
    expect(header.created_by).toBe("user-1");
    expect(header.client_write_key).toBe("key-1");
    expect(header.offline_authored_at).toBe("2026-07-31T16:02:00.000Z");
    // no forged provenance fields
    expect(header).not.toHaveProperty("submitted_at");
    expect(header).not.toHaveProperty("decided_at");

    const lines = h.state.inserts.find((i) => i.table === "material_request_lines")!
      .rows as Array<Record<string, unknown>>;
    expect(lines.map((l) => l.sort_order)).toEqual([0, 1]);
    expect(lines.every((l) => l.org_id === "org-A")).toBe(true);
  });

  it("complete replay: key found + lines present → duplicate, and NOTHING is written or allocated", async () => {
    scriptReads("material_requests", { data: { id: "mr-1" }, error: null });
    scriptReads("material_request_lines", { data: [{ id: "l-1" }], error: null });
    const out = await createMaterialRequestDraftRecord({
      ctx: ctx("org-A"),
      user,
      input: MR_INPUT,
      clientKey: "key-1",
    });
    expect(out).toEqual({ status: "duplicate", id: "mr-1" });
    expect(h.state.inserts).toHaveLength(0);
    expect(h.state.rpcs).toHaveLength(0); // no number burned on a replay
  });

  it("STRANDED HEADER RECOVERY: key found + ZERO lines → the lines are written now", async () => {
    // The crash-between-statements case: reporting "duplicate" here without
    // writing the lines would green-tick a request that never says what the
    // site asked for — the exact data-loss machine 20261077's header describes.
    scriptReads("material_requests", { data: { id: "mr-1" }, error: null });
    scriptReads("material_request_lines", { data: [], error: null });
    scriptInserts("material_request_lines", { error: null });
    const out = await createMaterialRequestDraftRecord({
      ctx: ctx("org-A"),
      user,
      input: MR_INPUT,
      clientKey: "key-1",
    });
    expect(out).toEqual({ status: "accepted", id: "mr-1" });
    const lines = h.state.inserts.find((i) => i.table === "material_request_lines")!
      .rows as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.material_request_id === "mr-1")).toBe(true);
  });

  it("the lines PROBE failing is a RETRY — empty-on-error must not re-insert", async () => {
    scriptReads("material_requests", { data: { id: "mr-1" }, error: null });
    scriptReads("material_request_lines", {
      data: null,
      error: { message: "blip", code: "XX000" },
    });
    const out = await createMaterialRequestDraftRecord({
      ctx: ctx("org-A"),
      user,
      input: MR_INPUT,
      clientKey: "key-1",
    });
    expect(out.status).toBe("retry");
    expect(h.state.inserts).toHaveLength(0);
  });

  it("concurrent replay: header 23505 + key re-read finds the winner → its lines are ensured", async () => {
    scriptReads(
      "material_requests",
      { data: null, error: null }, // key-first lookup: not there yet
      { data: { id: "mr-9" }, error: null }, // after 23505: the other tab won
    );
    h.state.script.rpc.push({ data: "MR-0008", error: null });
    scriptInserts("material_requests", { error: { message: "dup", code: "23505" } });
    scriptReads("material_request_lines", { data: [{ id: "l-1" }], error: null });
    const out = await createMaterialRequestDraftRecord({
      ctx: ctx("org-A"),
      user,
      input: MR_INPUT,
      clientKey: "key-1",
    });
    expect(out).toEqual({ status: "duplicate", id: "mr-9" });
  });

  it("A NUMBER RACE IS A RETRY, NEVER A DUPLICATE — the request was not written", async () => {
    scriptReads(
      "material_requests",
      { data: null, error: null }, // key-first lookup
      { data: null, error: null }, // after 23505: our key is NOT there ⇒ it was the number
    );
    h.state.script.rpc.push({ data: "MR-0008", error: null });
    scriptInserts("material_requests", { error: { message: "dup", code: "23505" } });
    const out = await createMaterialRequestDraftRecord({
      ctx: ctx("org-A"),
      user,
      input: MR_INPUT,
      clientKey: "key-1",
    });
    expect(out).toEqual({ status: "retry", reason: "number_conflict" });
  });

  it("two recoveries race: the loser's line insert 23505s → duplicate, never doubled lines", async () => {
    scriptReads("material_requests", { data: { id: "mr-1" }, error: null });
    scriptReads("material_request_lines", { data: [], error: null });
    scriptInserts("material_request_lines", {
      error: { message: "dup", code: "23505" }, // (material_request_id, sort_order)
    });
    const out = await createMaterialRequestDraftRecord({
      ctx: ctx("org-A"),
      user,
      input: MR_INPUT,
      clientKey: "key-1",
    });
    expect(out).toEqual({ status: "duplicate", id: "mr-1" });
  });

  it("cross-org job → job_missing before any allocation or write", async () => {
    scriptReads("material_requests", { data: null, error: null });
    scriptReads("jobs", { data: null, error: null });
    const out = await createMaterialRequestDraftRecord({
      ctx: ctx("org-A"),
      user,
      input: { ...MR_INPUT, job_id: "33333333-3333-4333-8333-333333333333" },
      clientKey: "key-1",
    });
    expect(out).toEqual({ status: "rejected", reason: "job_missing" });
    expect(h.state.rpcs).toHaveLength(0);
    expect(h.state.inserts).toHaveLength(0);
  });

  it("a line naming another org's catalogue item → stock_item_missing; a failed check stays transient", async () => {
    scriptReads("material_requests", { data: null, error: null });
    scriptReads("stock_items", { data: [], error: null }); // readable, absent in org
    const out = await createMaterialRequestDraftRecord({
      ctx: ctx("org-A"),
      user,
      input: {
        ...MR_INPUT,
        lines: [
          {
            description: "Cement 25kg",
            qty: 1,
            unit: "bag",
            stock_item_id: "44444444-4444-4444-8444-444444444444",
          },
        ],
      },
      clientKey: "key-1",
    });
    expect(out).toEqual({ status: "rejected", reason: "stock_item_missing" });

    // and the SAME check on a read blip retries instead of permanently rejecting
    scriptReads("material_requests", { data: null, error: null });
    scriptReads("stock_items", { data: null, error: { message: "blip", code: "XX000" } });
    const blip = await createMaterialRequestDraftRecord({
      ctx: ctx("org-A"),
      user,
      input: {
        ...MR_INPUT,
        lines: [
          {
            description: "Cement 25kg",
            qty: 1,
            unit: "bag",
            stock_item_id: "44444444-4444-4444-8444-444444444444",
          },
        ],
      },
      clientKey: "key-1",
    });
    expect(blip.status).toBe("retry");
  });

  it("a failed number allocation is a RETRY (the item keeps waiting, nothing burned)", async () => {
    scriptReads("material_requests", { data: null, error: null });
    h.state.script.rpc.push({ data: null, error: { message: "boom", code: "57014" } });
    const out = await createMaterialRequestDraftRecord({
      ctx: ctx("org-A"),
      user,
      input: MR_INPUT,
      clientKey: "key-1",
    });
    expect(out.status).toBe("retry");
    expect(h.state.inserts).toHaveLength(0);
  });
});
