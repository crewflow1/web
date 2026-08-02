import "fake-indexeddb/auto";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  enqueue,
  listForPartition,
  clearAll,
} from "@/lib/offline/write-queue";
import type { OrgContext } from "@/server/auth/session";

/**
 * Train "offl" — the two new offline verticals, delay_event.create and
 * site_report.create (both DRAFT creates), exercised for REAL against a scripted
 * Supabase mock: the queue's handling of their payloads, the dispatch refusals,
 * and each write core's accepted / duplicate / guard / classification branches.
 *
 * The DB-level halves (the unique indexes actually firing under RLS) are in
 * __tests__/integration/rls/offline-write-expansion-2.test.ts.
 */

// ── mock: a flexible supabase-js-shaped client ───────────────────────────────
// The chain is THENABLE so a terminal `.eq()` resolves a COUNT query (the site
// report's cosmetic number), while `.maybeSingle()` resolves a row read and
// `.insert()` resolves a write — each drawn from its own per-table script queue.
const h = vi.hoisted(() => {
  type PgErr = { message: string; code?: string } | null;
  const state = {
    inserts: [] as Array<{ table: string; rows: unknown }>,
    reads: [] as Array<{ table: string; eqs: Array<[string, unknown]> }>,
    script: {
      reads: new Map<string, Array<{ data: unknown; error: PgErr }>>(),
      counts: new Map<string, Array<{ count: number | null }>>(),
      inserts: new Map<string, Array<{ error: PgErr }>>(),
    },
    createClientCalls: 0,
  };
  const shift = <T>(m: Map<string, T[]>, table: string, chan: string): T => {
    const q = m.get(table);
    if (!q || q.length === 0) throw new Error(`unscripted ${chan} on ${table}`);
    return q.shift()!;
  };
  const client = {
    from(table: string) {
      const read = { table, eqs: [] as Array<[string, unknown]> };
      let isCount = false;
      const chain = {
        select: (_c: string, opts?: { count?: string }) => {
          if (opts?.count) isCount = true;
          return chain;
        },
        eq: (k: string, v: unknown) => {
          read.eqs.push([k, v]);
          return chain;
        },
        maybeSingle: async () => {
          state.reads.push(read);
          return shift(state.script.reads, table, "read");
        },
        insert: async (rows: unknown) => {
          state.inserts.push({ table, rows });
          return shift(state.script.inserts, table, "insert");
        },
        // Awaiting the builder directly (no maybeSingle/insert) is the count query.
        then: (
          resolve: (v: unknown) => void,
          reject: (e: unknown) => void,
        ) => {
          try {
            if (!isCount) throw new Error(`awaited a non-count builder on ${table}`);
            state.reads.push(read);
            resolve(shift(state.script.counts, table, "count"));
          } catch (e) {
            reject(e);
          }
        },
      };
      return chain;
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

// The site-report core seeds its draft from this read-only aggregator; offline
// it must still run (online, at replay) exactly as the form post runs it.
const sourcesCalls = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("@/server/services/site-report-sources", () => ({
  gatherReportSources: async (...a: unknown[]) => {
    sourcesCalls.calls.push(a);
    return { diary: [], snags: [], toolbox: [] };
  },
}));

import { dispatchOfflineWrite } from "@/server/services/offline-writes";
import { createDelayEventDraftRecord } from "@/server/services/delay-event-writes";
import { createSiteReportDraftRecord } from "@/server/services/site-report-writes";

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
const KEY = "22222222-2222-4222-8222-222222222222";
const JOB = "11111111-1111-4111-8111-111111111111";

const scriptReads = (t: string, ...r: Array<{ data: unknown; error: unknown }>) =>
  h.state.script.reads.set(t, r as Array<{ data: unknown; error: { message: string; code?: string } | null }>);
const scriptCounts = (t: string, ...r: Array<{ count: number | null }>) =>
  h.state.script.counts.set(t, r);
const scriptInserts = (t: string, ...r: Array<{ error: unknown }>) =>
  h.state.script.inserts.set(t, r as Array<{ error: { message: string; code?: string } | null }>);

beforeEach(async () => {
  await clearAll();
  h.state.inserts.length = 0;
  h.state.reads.length = 0;
  h.state.script.reads.clear();
  h.state.script.counts.clear();
  h.state.script.inserts.clear();
  h.state.createClientCalls = 0;
  auditCalls.calls.length = 0;
  sourcesCalls.calls.length = 0;
});

const DELAY_INPUT = {
  jobId: JOB,
  category: "weather" as const,
  startedOn: "2026-07-30",
  endedOn: "2026-07-31",
  workingDaysLost: 2,
  description: "Heavy rain stopped groundworks",
};
const REPORT_INPUT = {
  job_id: JOB,
  title: "Week 30 progress",
  period_start: "2026-07-27",
  period_end: "2026-07-31",
};

// ── the queue accepts (and strips) the new kinds' payloads ───────────────────
describe("write queue — the new kinds' payloads", () => {
  it("delay_event.create: unknown keys + a lifecycle status are STRIPPED before storage", async () => {
    const res = await enqueue({
      userId: "u1",
      orgId: "o1",
      kind: "delay_event.create",
      payload: {
        ...DELAY_INPUT,
        status: "recorded", // never client-settable
        recorded_at: "2026-07-30T09:00:00Z", // forged provenance — must not ride
        access_token: "secret",
      },
    });
    expect(res.ok).toBe(true);
    const [item] = await listForPartition("u1", "o1");
    expect(item!.payload).toEqual(DELAY_INPUT);
  });

  it("site_report.create: extras stripped; only the create schema survives", async () => {
    const res = await enqueue({
      userId: "u1",
      orgId: "o1",
      kind: "site_report.create",
      payload: { ...REPORT_INPUT, status: "issued", report_number: "SR-9999", token: "x" },
    });
    expect(res.ok).toBe(true);
    const [item] = await listForPartition("u1", "o1");
    expect(item!.payload).toEqual(REPORT_INPUT);
  });

  it("refuses an invalid payload for each new kind rather than storing junk", async () => {
    const badDelay = await enqueue({
      userId: "u1",
      orgId: "o1",
      kind: "delay_event.create",
      payload: { ...DELAY_INPUT, description: "" },
    });
    expect(badDelay).toEqual({ ok: false, error: "invalid_payload" });
    const badReport = await enqueue({
      userId: "u1",
      orgId: "o1",
      kind: "site_report.create",
      payload: { ...REPORT_INPUT, period_end: "2026-07-01" }, // before start
    });
    expect(badReport).toEqual({ ok: false, error: "invalid_payload" });
  });
});

// ── dispatch refusals (hermetic — refused before any DB client exists) ───────
describe("dispatch — the new kinds are refused exactly like the diary", () => {
  it("org_mismatch: authored for org A, org B active → REFUSED, never re-homed", async () => {
    for (const [kind, payload] of [
      ["delay_event.create", DELAY_INPUT],
      ["site_report.create", REPORT_INPUT],
    ] as const) {
      const out = await dispatchOfflineWrite({
        ctx: ctx("org-B"),
        user,
        item: { clientKey: KEY, kind, orgId: "org-A", payload, authoredAt: "2026-07-31T16:02:00.000Z" },
      });
      expect(out, kind).toEqual({ status: "rejected", reason: "org_mismatch" });
    }
    expect(h.state.createClientCalls).toBe(0);
  });

  it("invalid payload for a valid kind → rejected before any write", async () => {
    const out = await dispatchOfflineWrite({
      ctx: ctx("org-A"),
      user,
      item: {
        clientKey: KEY,
        kind: "delay_event.create",
        orgId: "org-A",
        payload: { ...DELAY_INPUT, category: "act_of_god" },
        authoredAt: "2026-07-31T16:02:00.000Z",
      },
    });
    expect(out).toEqual({ status: "rejected", reason: "invalid_payload" });
    expect(h.state.createClientCalls).toBe(0);
  });
});

// ── delay-event core ──────────────────────────────────────────────────────────
describe("createDelayEventDraftRecord — the shared delay-event write core", () => {
  it("accepted: pins org + author + status 'draft', persists the key + offline provenance", async () => {
    scriptReads("jobs", { data: { id: "job-1" }, error: null });
    scriptInserts("delay_events", { error: null });
    const out = await createDelayEventDraftRecord({
      ctx: ctx("org-A"),
      user,
      input: DELAY_INPUT,
      clientKey: KEY,
      offlineAuthoredAt: "2026-07-31T16:02:00.000Z",
    });
    expect(out.status).toBe("accepted");
    const row = h.state.inserts[0]!.rows as Record<string, unknown>;
    expect(h.state.inserts[0]!.table).toBe("delay_events");
    expect(row.org_id).toBe("org-A"); // session org, never the payload's
    expect(row.created_by).toBe("user-1"); // session user
    expect(row.status).toBe("draft"); // born draft — never from the payload
    expect(row.job_id).toBe(JOB);
    expect(row.working_days_lost).toBe(2);
    expect(row.client_write_key).toBe(KEY);
    expect(row.offline_authored_at).toBe("2026-07-31T16:02:00.000Z");
    // NO forged lifecycle provenance is ever written
    expect(row).not.toHaveProperty("recorded_at");
    expect(row).not.toHaveProperty("recorded_by");
  });

  it("duplicate: 23505 → org-pinned + key-pinned lookup → the EXISTING row id", async () => {
    scriptReads("jobs", { data: { id: "job-1" }, error: null });
    scriptInserts("delay_events", { error: { message: "dup", code: "23505" } });
    scriptReads("delay_events", { data: { id: "de-1" }, error: null });
    const out = await createDelayEventDraftRecord({ ctx: ctx("org-A"), user, input: DELAY_INPUT, clientKey: KEY });
    expect(out).toEqual({ status: "duplicate", id: "de-1" });
    const lookup = h.state.reads.find((r) => r.table === "delay_events");
    expect(lookup!.eqs).toContainEqual(["org_id", "org-A"]);
    expect(lookup!.eqs).toContainEqual(["client_write_key", KEY]);
  });

  it("the duplicate lookup's OWN failure is a RETRY, never a rejection", async () => {
    scriptReads("jobs", { data: { id: "job-1" }, error: null });
    scriptInserts("delay_events", { error: { message: "dup", code: "23505" } });
    scriptReads("delay_events", { data: null, error: { message: "blip", code: "XX000" } });
    const out = await createDelayEventDraftRecord({ ctx: ctx("org-A"), user, input: DELAY_INPUT, clientKey: KEY });
    expect(out.status).toBe("retry");
  });

  it("cross-org job → job_missing, before any insert", async () => {
    scriptReads("jobs", { data: null, error: null });
    const out = await createDelayEventDraftRecord({ ctx: ctx("org-A"), user, input: DELAY_INPUT, clientKey: KEY });
    expect(out).toEqual({ status: "rejected", reason: "job_missing" });
    expect(h.state.inserts).toHaveLength(0);
    const lookup = h.state.reads.find((r) => r.table === "jobs");
    expect(lookup!.eqs).toContainEqual(["org_id", "org-A"]);
  });

  it("a FK violation (23503) is a permanent job_missing; an unclassified failure is a RETRY", async () => {
    scriptReads("jobs", { data: { id: "job-1" }, error: null });
    scriptInserts("delay_events", { error: { message: "fk", code: "23503" } });
    const fk = await createDelayEventDraftRecord({ ctx: ctx("org-A"), user, input: DELAY_INPUT, clientKey: KEY });
    expect(fk).toEqual({ status: "rejected", reason: "job_missing" });

    scriptReads("jobs", { data: { id: "job-1" }, error: null });
    scriptInserts("delay_events", { error: { message: "boom", code: "57014" } });
    const boom = await createDelayEventDraftRecord({ ctx: ctx("org-A"), user, input: DELAY_INPUT, clientKey: KEY });
    expect(boom.status).toBe("retry");
  });
});

// ── site-report core ──────────────────────────────────────────────────────────
describe("createSiteReportDraftRecord — key-first draft create", () => {
  it("fresh write: key miss → job resolve → sources seeded → cosmetic number → draft insert + audit", async () => {
    scriptReads("site_reports", { data: null, error: null }); // key-first: unknown
    scriptReads("jobs", { data: { id: "job-1", customer_id: "cust-1" }, error: null });
    scriptCounts("site_reports", { count: 6 });
    scriptInserts("site_reports", { error: null });
    const out = await createSiteReportDraftRecord({
      ctx: ctx("org-A"),
      user,
      input: REPORT_INPUT,
      clientKey: KEY,
      offlineAuthoredAt: "2026-07-31T16:02:00.000Z",
    });
    expect(out.status).toBe("accepted");
    expect(sourcesCalls.calls).toHaveLength(1); // sources gathered at replay
    const row = h.state.inserts[0]!.rows as Record<string, unknown>;
    expect(h.state.inserts[0]!.table).toBe("site_reports");
    expect(row.org_id).toBe("org-A");
    expect(row.customer_id).toBe("cust-1"); // resolved from the job
    expect(row.report_number).toBe("SR-0007"); // count 6 → next label, at SYNC time
    expect(row.status).toBe("draft"); // born draft
    expect(row.revision).toBe(1);
    expect(row.prepared_by).toBe("user-1");
    expect(row.client_write_key).toBe(KEY);
    expect(row.offline_authored_at).toBe("2026-07-31T16:02:00.000Z");
    expect(row.content).toEqual({
      sources: { diary_entry_ids: [], snag_ids: [], toolbox_talk_ids: [], photo_attachment_ids: [] },
    });
    // no lifecycle provenance forged
    expect(row).not.toHaveProperty("issued_at");
    expect(row).not.toHaveProperty("approved_at");
    expect(auditCalls.calls).toHaveLength(1);
    expect(auditCalls.calls[0]!.action).toBe("site_report.created");
    expect((auditCalls.calls[0]!.metadata as Record<string, unknown>).offline).toBe(true);
  });

  it("complete replay: key found FIRST → duplicate, and NOTHING is read, allocated or written", async () => {
    scriptReads("site_reports", { data: { id: "sr-1" }, error: null });
    const out = await createSiteReportDraftRecord({ ctx: ctx("org-A"), user, input: REPORT_INPUT, clientKey: KEY });
    expect(out).toEqual({ status: "duplicate", id: "sr-1" });
    expect(sourcesCalls.calls).toHaveLength(0); // no re-gather on a replay
    expect(h.state.inserts).toHaveLength(0);
    expect(auditCalls.calls).toHaveLength(0);
  });

  it("the key-first lookup failing is a RETRY, never a rejection", async () => {
    scriptReads("site_reports", { data: null, error: { message: "blip", code: "XX000" } });
    const out = await createSiteReportDraftRecord({ ctx: ctx("org-A"), user, input: REPORT_INPUT, clientKey: KEY });
    expect(out.status).toBe("retry");
    expect(h.state.inserts).toHaveLength(0);
  });

  it("cross-org job → job_missing, after the key miss and before any write", async () => {
    scriptReads("site_reports", { data: null, error: null });
    scriptReads("jobs", { data: null, error: null });
    const out = await createSiteReportDraftRecord({ ctx: ctx("org-A"), user, input: REPORT_INPUT, clientKey: KEY });
    expect(out).toEqual({ status: "rejected", reason: "job_missing" });
    expect(h.state.inserts).toHaveLength(0);
    expect(sourcesCalls.calls).toHaveLength(0);
  });

  it("concurrent replay: insert 23505 + key re-read finds the winner → duplicate", async () => {
    scriptReads(
      "site_reports",
      { data: null, error: null }, // key-first miss
      { data: { id: "sr-9" }, error: null }, // after 23505: the other tab won
    );
    scriptReads("jobs", { data: { id: "job-1", customer_id: null }, error: null });
    scriptCounts("site_reports", { count: 0 });
    scriptInserts("site_reports", { error: { message: "dup", code: "23505" } });
    const out = await createSiteReportDraftRecord({ ctx: ctx("org-A"), user, input: REPORT_INPUT, clientKey: KEY });
    expect(out).toEqual({ status: "duplicate", id: "sr-9" });
  });

  it("insert 23505 but the key is absent on re-read → not_permitted (a row we cannot show)", async () => {
    scriptReads(
      "site_reports",
      { data: null, error: null }, // key-first miss
      { data: null, error: null }, // after 23505: still not ours ⇒ RLS-invisible
    );
    scriptReads("jobs", { data: { id: "job-1", customer_id: null }, error: null });
    scriptCounts("site_reports", { count: 0 });
    scriptInserts("site_reports", { error: { message: "dup", code: "23505" } });
    const out = await createSiteReportDraftRecord({ ctx: ctx("org-A"), user, input: REPORT_INPUT, clientKey: KEY });
    expect(out).toEqual({ status: "rejected", reason: "not_permitted" });
  });
});
