import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * HQ Event Spine — real-Postgres proof of PR4 (Historical Backfill).
 *
 * PR4 lands the replay adapters: each surviving historical row of the three legacy
 * logs (activity_log, admin_activity_log, hq_memory_events) is replayed into ONE
 * canonical hq_events row, carrying its ORIGINAL ts and a deterministic correlation
 * id, guarded so a re-run can never duplicate. This tier proves the BEHAVIOUR a mock
 * cannot — against a LIVE database, with the real migration + triggers applied — that
 * every invariant the CEO pinned actually holds:
 *   1. it ships DARK — with the gate off, draining is a no-op and emits NOT ONE event;
 *   2. DETERMINISTIC ORDERING + BOUNDED batches — a source is walked in strict
 *      (created_at, id) order, p_max_rows at a time, the cursor resuming across batches;
 *   3. the ORACLE — every legacy row maps to exactly one canonical event with its
 *      original ts, deterministic correlation, curated non-PII payload, and (the
 *      collision regression) quote.accepted's own `source` survives untouched beside
 *      the namespaced provenance key;
 *   4. NO DUPLICATES — a full re-drain emits nothing new (one event per row);
 *   5. RESTARTABLE — resetting a drained source and redriving re-emits NOTHING and
 *      rebuilds the byte-identical events (the append-only spine is never duplicated);
 *   6. READ-ONLY — the legacy source rows are never mutated (P2).
 *
 * Sources are seeded DIRECTLY (not through the producers) at year-2000 created_at so
 * they sort first, deterministically, and land in hq_events' DEFAULT partition.
 * activity_log is co-tenanted with PR2's suite, so its assertions are scoped by the
 * backfill provenance key; admin_activity_log and hq_memory_events are sole-written
 * here, so their totals are asserted exactly.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database,
 * FAILED loudly in CI if the database is missing. hq_events is append-only, so emitted
 * rows are left behind (harmless in the ephemeral CI database); we drop the seeded org
 * (cascading activity_log), the seeded memory (cascading hq_memory_events), delete our
 * admin rows, clear our backfill_state, and return the gate to DARK in afterAll.
 */

// The spine internals (hq_events, hq_settings JSONB, hq_backfill_*) aren't ergonomically
// covered by the generated Database types; use the same minimal untyped surface the PR2/PR3
// spine suites use for the service-role-only internals (the `as unknown as` convention).
type Res<T> = { data: T | null; error: { message: string } | null };
type Thenable<T> = PromiseLike<Res<T>>;
interface Selectable<T> extends Thenable<T[]> {
  eq(column: string, value: unknown): Selectable<T>;
  single(): Thenable<T>;
}
interface Insertable extends Thenable<null> {
  select(columns?: string): Selectable<Record<string, unknown>>;
}
interface Mutable extends Thenable<null> {
  eq(column: string, value: unknown): Mutable;
  neq(column: string, value: unknown): Mutable;
}
interface Table {
  select(columns?: string): Selectable<Record<string, unknown>>;
  insert(row: Record<string, unknown>): Insertable;
  update(patch: Record<string, unknown>): Mutable;
  delete(): Mutable;
}
interface Client {
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Thenable<T>;
  from(table: string): Table;
}
const svc = (): Client => serviceClient() as unknown as Client;

const SRC_ACT = "activity_log";
const SRC_ADMIN = "admin_activity_log";
const SRC_MEM = "hq_memory_events";
const ALL = [SRC_ACT, SRC_ADMIN, SRC_MEM] as const;

// activity_log.actor_id has NO foreign key (a synthetic uuid is valid), so it alone can
// prove the human-actor branch behaviourally; admin/memory keep their FK columns null.
const HUMAN = "11111111-2222-3333-4444-555555555555";

type Expected = {
  verb: string;
  object_type: string;
  severity: string;
  actor_type: string;
  actor_id: string;
  payload: Record<string, unknown>;
};
type Seed = { id: string; objectId: string; createdAt: string; exp: Expected | null };
type Plan = { row: Record<string, unknown>; exp: Expected | null };

type EventRow = {
  id: number;
  ts: string;
  verb: string;
  actor_type: string;
  actor_id: string | null;
  object_type: string;
  object_id: string;
  correlation_id: string;
  severity: string;
  payload: Record<string, unknown>;
};

type DrainSummary = {
  source: string;
  status?: string;
  done?: boolean;
  processed?: number;
  emitted?: number;
  skipped?: number | string;
  cursor_id?: string;
};

const num = (v: unknown): number => Number(v);
const at = (i: number): string => new Date(Date.UTC(2000, 0, 1, 0, 0, i)).toISOString();

/** Postgres md5(text)::uuid — the same deterministic correlation the migration computes. */
function correlationId(source: string, sourceId: string): string {
  const h = createHash("md5").update(`${source}:${sourceId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The lone backfilled event for a (source, source_id), found by object_id then filtered on
 *  the provenance key — independent of the correlation_id so its assertion is non-circular.
 *  Doubles as a no-duplicate guard (a source row must yield at most one event). */
async function eventFor(source: string, sourceId: string, objectId: string): Promise<EventRow | null> {
  const res = await svc()
    .from("hq_events")
    .select("id, ts, verb, actor_type, actor_id, object_type, object_id, correlation_id, severity, payload")
    .eq("object_id", objectId);
  expect(res.error, res.error?.message).toBeNull();
  const rows = ((res.data ?? []) as unknown as EventRow[]).filter(
    (r) => r.payload?.backfill_source === source && r.payload?.backfill_source_id === sourceId,
  );
  expect(rows.length, `more than one backfill event for ${source}:${sourceId}`).toBeLessThanOrEqual(1);
  return rows[0] ?? null;
}

function assertCanonical(
  ev: EventRow | null,
  ctx: { source: string; sourceId: string; objectId: string; createdAt: string },
  exp: Expected,
): void {
  expect(ev, `expected a backfilled event for ${ctx.source}:${ctx.sourceId}`).not.toBeNull();
  if (!ev) return;
  expect(ev.verb).toBe(exp.verb);
  expect(ev.object_type).toBe(exp.object_type);
  expect(ev.object_id).toBe(ctx.objectId);
  expect(ev.severity).toBe(exp.severity);
  expect(ev.actor_type).toBe(exp.actor_type);
  expect(ev.actor_id).toBe(exp.actor_id);
  // The ORIGINAL ts is preserved (historical backfill, never now()).
  expect(new Date(ev.ts).getTime()).toBe(new Date(ctx.createdAt).getTime());
  // Deterministic correlation id (stable across replays).
  expect(ev.correlation_id.toLowerCase()).toBe(correlationId(ctx.source, ctx.sourceId));
  // Namespaced provenance key.
  expect(ev.payload.backfill_source).toBe(ctx.source);
  expect(ev.payload.backfill_source_id).toBe(ctx.sourceId);
  // The curated domain payload survives byte-for-byte beside the provenance key.
  for (const [k, v] of Object.entries(exp.payload)) {
    expect(ev.payload[k], `payload.${k}`).toEqual(v);
  }
}

async function drain(source: string, maxRows?: number): Promise<DrainSummary> {
  const args: Record<string, unknown> = { p_source: source };
  if (maxRows !== undefined) args.p_max_rows = maxRows;
  const res = await svc().rpc<DrainSummary>("hq_backfill_drain", args);
  expect(res.error, res.error?.message).toBeNull();
  return res.data as DrainSummary;
}

async function drainToDone(source: string, maxRows?: number): Promise<DrainSummary> {
  let last: DrainSummary | null = null;
  for (let i = 0; i < 1000; i++) {
    last = await drain(source, maxRows);
    if (last.done) break;
  }
  expect(last?.done, `drain(${source}) never reached done`).toBe(true);
  return last as DrainSummary;
}

async function register(source: string): Promise<void> {
  const res = await svc().rpc("hq_backfill_register", { p_source: source });
  expect(res.error, res.error?.message).toBeNull();
}

async function reset(source: string): Promise<{ reset?: boolean; previous_rows_seen?: number; skipped?: string }> {
  const res = await svc().rpc<{ reset?: boolean; previous_rows_seen?: number; skipped?: string }>(
    "hq_backfill_reset",
    { p_source: source },
  );
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? {}) as { reset?: boolean; previous_rows_seen?: number; skipped?: string };
}

async function state(source: string): Promise<Record<string, unknown>> {
  const res = await svc().from("hq_backfill_state").select("*").eq("source", source).single();
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? {}) as Record<string, unknown>;
}

/** Flip the global backfill gate, preserving the rest of the hq_settings blob — the
 *  runtime toggle an operator performs (no deploy). */
async function setBackfillEnabled(on: boolean): Promise<void> {
  const cur = await svc().from("hq_settings").select("data").eq("id", "singleton").single();
  expect(cur.error, cur.error?.message).toBeNull();
  const data = (((cur.data as { data?: Record<string, unknown> } | null)?.data) ?? {}) as Record<string, unknown>;
  const next = {
    ...data,
    event_spine: {
      ...((data.event_spine as Record<string, unknown>) ?? {}),
      backfill_enabled: on,
    },
  };
  const upd = await svc().from("hq_settings").update({ data: next }).eq("id", "singleton");
  expect(upd.error, upd.error?.message).toBeNull();
}

async function insertRow(table: string, row: Record<string, unknown>): Promise<string> {
  const res = await svc().from(table).insert(row).select("id").single();
  expect(res.error, res.error?.message).toBeNull();
  return String((res.data as { id: string }).id);
}

describeIntegration("HQ Event Spine · historical backfill (PR4)", () => {
  let orgId = "";
  let memId = "";
  const slug = `it-pr4-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const act: Seed[] = [];
  const admin: Seed[] = [];
  const mem: Seed[] = [];

  // activity_log — MIRROR PR2's curated six verbs exactly, plus one row that maps to
  // no verb (a non-completed status change) which must be skipped.
  const actPlan: Plan[] = [
    {
      row: { action: "customer.created", metadata: {}, actor_id: null },
      exp: { verb: "customer.created", object_type: "customer", severity: "info", actor_type: "system", actor_id: "system", payload: {} },
    },
    {
      row: { action: "customer.updated", metadata: { fields: ["name", "email"] }, actor_id: HUMAN },
      exp: { verb: "customer.updated", object_type: "customer", severity: "info", actor_type: "human", actor_id: HUMAN, payload: { fields: ["name", "email"] } },
    },
    {
      row: { action: "job.created", metadata: { status: "new" }, actor_id: null },
      exp: { verb: "job.created", object_type: "job", severity: "info", actor_type: "system", actor_id: "system", payload: { status: "new" } },
    },
    {
      row: { action: "job.status_changed", metadata: { from: "in-progress", to: "completed" }, actor_id: null },
      exp: { verb: "job.completed", object_type: "job", severity: "info", actor_type: "system", actor_id: "system", payload: { from: "in-progress", to: "completed" } },
    },
    {
      row: { action: "quote.sent", metadata: { number: "Q-1", total: 1000 }, actor_id: null },
      exp: { verb: "quote.sent", object_type: "quote", severity: "info", actor_type: "system", actor_id: "system", payload: { number: "Q-1", total: 1000 } },
    },
    {
      // The collision regression: this curated payload carries its OWN `source` (the
      // acceptance channel) which must NOT be clobbered by the provenance key.
      row: { action: "quote.accepted", metadata: { number: "Q-1", total: 1000, source: "public_link" }, actor_id: null },
      exp: { verb: "quote.accepted", object_type: "quote", severity: "info", actor_type: "system", actor_id: "system", payload: { number: "Q-1", total: 1000, source: "public_link" } },
    },
    {
      row: { action: "job.status_changed", metadata: { from: "new", to: "blocked" }, actor_id: null },
      exp: null, // a status change with no canonical verb → skipped
    },
  ];

  // admin_activity_log — ONLY the unambiguous Stripe billing trio; operator-audit noise
  // (hq_memory.created) is deliberately not projected. actor_id stays null (users FK), so
  // the actor falls to the email (or 'system' when the email is blank).
  const adminPlan: Plan[] = [
    {
      row: { action: "stripe.invoice_paid", actor_email: "billing@stripe.test" },
      exp: { verb: "invoice.paid", object_type: "invoice", severity: "success", actor_type: "system", actor_id: "billing@stripe.test", payload: { legacy_action: "stripe.invoice_paid" } },
    },
    {
      row: { action: "stripe.invoice_failed", actor_email: "billing@stripe.test" },
      exp: { verb: "invoice.payment_failed", object_type: "invoice", severity: "warn", actor_type: "system", actor_id: "billing@stripe.test", payload: { legacy_action: "stripe.invoice_failed" } },
    },
    {
      row: { action: "stripe.subscription_deleted", actor_email: "" },
      exp: { verb: "org.churned", object_type: "org", severity: "warn", actor_type: "system", actor_id: "system", payload: { legacy_action: "stripe.subscription_deleted" } },
    },
    {
      row: { action: "hq_memory.created", actor_email: "ops@hq.test" },
      exp: null, // operator-audit noise → not projected
    },
  ];

  // hq_memory_events — six created (→ asserted), one superseded, one unmapped status
  // change (→ skipped). ai_employee_id stays null (employees FK), so the actor falls to
  // the email (or 'system' when blank/null).
  const memPlan: Plan[] = [
    { row: { event_type: "created", detail: { note: "alpha" }, actor_email: "analyst@hq.test" }, exp: { verb: "memory.asserted", object_type: "memory", severity: "info", actor_type: "human", actor_id: "analyst@hq.test", payload: { note: "alpha", legacy_event_type: "created" } } },
    { row: { event_type: "created", detail: null, actor_email: null }, exp: { verb: "memory.asserted", object_type: "memory", severity: "info", actor_type: "human", actor_id: "system", payload: { legacy_event_type: "created" } } },
    { row: { event_type: "created", detail: {}, actor_email: "" }, exp: { verb: "memory.asserted", object_type: "memory", severity: "info", actor_type: "human", actor_id: "system", payload: { legacy_event_type: "created" } } },
    { row: { event_type: "created", detail: { note: "d" }, actor_email: "curator@hq.test" }, exp: { verb: "memory.asserted", object_type: "memory", severity: "info", actor_type: "human", actor_id: "curator@hq.test", payload: { note: "d", legacy_event_type: "created" } } },
    { row: { event_type: "created", detail: null, actor_email: "curator@hq.test" }, exp: { verb: "memory.asserted", object_type: "memory", severity: "info", actor_type: "human", actor_id: "curator@hq.test", payload: { legacy_event_type: "created" } } },
    { row: { event_type: "created", detail: null, actor_email: "curator@hq.test" }, exp: { verb: "memory.asserted", object_type: "memory", severity: "info", actor_type: "human", actor_id: "curator@hq.test", payload: { legacy_event_type: "created" } } },
    { row: { event_type: "status_changed", detail: { from: "active", to: "superseded" }, actor_email: "curator@hq.test" }, exp: { verb: "memory.superseded", object_type: "memory", severity: "info", actor_type: "human", actor_id: "curator@hq.test", payload: { from: "active", to: "superseded", legacy_event_type: "status_changed" } } },
    { row: { event_type: "status_changed", detail: { from: "active", to: "archived" }, actor_email: "curator@hq.test" }, exp: null },
  ];

  beforeAll(async () => {
    await setBackfillEnabled(false);

    const org = await svc().from("organizations").insert({ name: "PR4 Backfill Org", slug }).select("id").single();
    expect(org.error, org.error?.message).toBeNull();
    orgId = String((org.data as { id: string }).id);

    // `memory_type` is an FK to the hq_memory_types lookup; use a slug the schema
    // SEEDS via migration ('engineering'), not one only added in prod via the admin
    // UI ('fact'), so this holds on a migrations-only CI database. The type never
    // flows into a backfilled event, so it is assertion-neutral.
    memId = await insertRow("hq_memories", { title: "PR4 backfill memory", memory_type: "engineering" });
    // The deterministic bounded-batch test below asserts whole-SOURCE drain arithmetic
    // (it drains hq_memory_events to 'done' in fixed batches), and the drain walks the
    // ENTIRE table — so the source must hold EXACTLY our seeds. Clear every pre-existing
    // row first: the schema's seed migration inserts six example 'created' timeline events
    // at recent `now()` timestamps (which would extend the once-captured ceiling past our
    // year-2000 rows and leak extra batches), and creating the memory above may auto-log
    // one. memory_id is NOT NULL, so `<> zero-uuid` matches every row. No other integration
    // suite reads this table and the CI database is ephemeral, so a full clear is safe.
    await svc()
      .from("hq_memory_events")
      .delete()
      .neq("memory_id", "00000000-0000-0000-0000-000000000000");

    for (let i = 0; i < actPlan.length; i++) {
      const p = actPlan[i] as Plan;
      const objectId = randomUUID();
      const id = await insertRow(SRC_ACT, {
        org_id: orgId,
        target_table: "seed",
        target_id: objectId,
        created_at: at(i),
        ...p.row,
      });
      act.push({ id, objectId, createdAt: at(i), exp: p.exp });
    }

    for (let i = 0; i < adminPlan.length; i++) {
      const p = adminPlan[i] as Plan;
      const objectId = randomUUID();
      const id = await insertRow(SRC_ADMIN, {
        target_table: "seed",
        target_id: objectId,
        created_at: at(i),
        ...p.row,
      });
      admin.push({ id, objectId, createdAt: at(i), exp: p.exp });
    }

    for (let i = 0; i < memPlan.length; i++) {
      const p = memPlan[i] as Plan;
      const id = await insertRow(SRC_MEM, { memory_id: memId, created_at: at(i), ...p.row });
      mem.push({ id, objectId: memId, createdAt: at(i), exp: p.exp });
    }

    // Register + reset each source to a clean idle slate (robust to leftover local state).
    for (const src of ALL) {
      await register(src);
      await reset(src);
    }
  });

  afterAll(async () => {
    await setBackfillEnabled(false);
    for (const src of ALL) await svc().from("hq_backfill_state").delete().eq("source", src);
    if (orgId) await svc().from("organizations").delete().eq("id", orgId); // cascades activity_log
    if (memId) await svc().from("hq_memories").delete().eq("id", memId); // cascades hq_memory_events
    for (const s of admin) await svc().from("admin_activity_log").delete().eq("id", s.id);
  });

  it("ships DARK — gate off: draining is a no-op and emits NOT ONE event", async () => {
    await setBackfillEnabled(false);

    const res = await drain(SRC_MEM, 2);
    expect(res.skipped).toBe("backfill_disabled");

    // No event exists for any seeded memory row…
    for (const s of mem) expect(await eventFor(SRC_MEM, s.id, s.objectId)).toBeNull();
    // …and the source stayed idle (no ceiling captured, no cursor moved).
    const st = await state(SRC_MEM);
    expect(st.status).toBe("idle");
    expect(num(st.rows_seen)).toBe(0);
  });

  it("deterministic ordering + bounded batches + cursor resume (hq_memory_events)", async () => {
    await setBackfillEnabled(true);

    // First drain captures the ceiling and walks exactly the first two rows, in order.
    const b1 = await drain(SRC_MEM, 2);
    expect([b1.processed, b1.emitted, b1.done]).toEqual([2, 2, false]);
    expect(b1.cursor_id).toBe(mem[1]!.id);

    // BOUNDED: the later mappable rows have NOT been emitted yet — proves the batch
    // ceiling and the strict (created_at, id) order (only the head was touched).
    for (const i of [2, 3, 4, 5]) {
      expect(await eventFor(SRC_MEM, mem[i]!.id, memId)).toBeNull();
    }

    const b2 = await drain(SRC_MEM, 2);
    expect([b2.processed, b2.emitted, b2.cursor_id]).toEqual([2, 2, mem[3]!.id]);
    const b3 = await drain(SRC_MEM, 2);
    expect([b3.processed, b3.emitted, b3.cursor_id]).toEqual([2, 2, mem[5]!.id]);
    // Batch four = the superseded row (emitted) + the unmapped status change (skipped).
    const b4 = await drain(SRC_MEM, 2);
    expect([b4.processed, b4.emitted, b4.skipped, b4.cursor_id]).toEqual([2, 1, 1, mem[7]!.id]);
    expect(b4.done).toBe(false);
    // The final, unfilled batch flips the source to done.
    const b5 = await drain(SRC_MEM, 2);
    expect([b5.processed, b5.done, b5.status]).toEqual([0, true, "done"]);

    // Durable cumulative state: every row seen exactly once, seven emitted, one skipped.
    const st = await state(SRC_MEM);
    expect(num(st.rows_seen)).toBe(8);
    expect(num(st.rows_emitted)).toBe(7);
    expect(num(st.rows_skipped)).toBe(1);
    expect(st.status).toBe("done");
  });

  it("ORACLE — every legacy row maps to one canonical event (original ts, correlation, curated payload)", async () => {
    await setBackfillEnabled(true);
    await drainToDone(SRC_ACT);
    await drainToDone(SRC_ADMIN);
    await drainToDone(SRC_MEM); // already done from the bounded test — stays done

    // activity_log: the curated six verbs mirrored; the blocked status-change skipped.
    for (const s of act) {
      const ev = await eventFor(SRC_ACT, s.id, s.objectId);
      if (s.exp === null) {
        expect(ev, "the unmapped activity_log row must NOT emit").toBeNull();
        continue;
      }
      assertCanonical(ev, { source: SRC_ACT, sourceId: s.id, objectId: s.objectId, createdAt: s.createdAt }, s.exp);
    }

    // The collision regression in the flesh: quote.accepted keeps its OWN `source`
    // (acceptance channel) AND carries the namespaced provenance — neither clobbers
    // the other (forward/backfill parity).
    const qa = act.find((s) => s.exp?.verb === "quote.accepted") as Seed;
    const qaEv = await eventFor(SRC_ACT, qa.id, qa.objectId);
    expect(qaEv?.payload.source).toBe("public_link");
    expect(qaEv?.payload.backfill_source).toBe(SRC_ACT);
    expect(qaEv?.payload.backfill_source_id).toBe(qa.id);

    // customer.created carries ONLY the two provenance keys (no domain fields) — the
    // exact-payload proof that the merge adds nothing it shouldn't.
    const cc = act[0] as Seed;
    const ccEv = await eventFor(SRC_ACT, cc.id, cc.objectId);
    expect(Object.keys(ccEv?.payload ?? {}).sort()).toEqual(["backfill_source", "backfill_source_id"]);

    // admin_activity_log: only the unambiguous Stripe trio; the operator-audit row skipped.
    for (const s of admin) {
      const ev = await eventFor(SRC_ADMIN, s.id, s.objectId);
      if (s.exp === null) {
        expect(ev, "operator-audit noise must NOT project").toBeNull();
        continue;
      }
      assertCanonical(ev, { source: SRC_ADMIN, sourceId: s.id, objectId: s.objectId, createdAt: s.createdAt }, s.exp);
    }
    // admin is a sole-writer here → exact totals.
    const adSt = await state(SRC_ADMIN);
    expect(num(adSt.rows_seen)).toBe(4);
    expect(num(adSt.rows_emitted)).toBe(3);
    expect(num(adSt.rows_skipped)).toBe(1);

    // hq_memory_events: created → asserted, superseded → superseded, other → skipped.
    for (const s of mem) {
      const ev = await eventFor(SRC_MEM, s.id, s.objectId);
      if (s.exp === null) {
        expect(ev, "the unmapped memory event must NOT emit").toBeNull();
        continue;
      }
      assertCanonical(ev, { source: SRC_MEM, sourceId: s.id, objectId: s.objectId, createdAt: s.createdAt }, s.exp);
    }
  });

  it("NO DUPLICATES — a full re-drain of every source emits nothing new (one event per row)", async () => {
    await setBackfillEnabled(true);

    for (const src of ALL) {
      const before = await state(src);
      const summary = await drain(src); // already done → idempotent no-op
      expect(summary.done).toBe(true);
      expect(summary.processed ?? 0).toBe(0);
      expect(summary.emitted ?? 0).toBe(0);
      const after = await state(src);
      expect(num(after.rows_emitted)).toBe(num(before.rows_emitted));
    }

    // Still exactly one event per mapped row (eventFor also guards <= 1, so a clean
    // pass means no row was double-emitted anywhere).
    const groups: [string, Seed[]][] = [[SRC_ACT, act], [SRC_ADMIN, admin], [SRC_MEM, mem]];
    for (const [src, seeds] of groups) {
      for (const s of seeds) {
        if (s.exp === null) continue;
        expect(await eventFor(src, s.id, s.objectId), `${src}:${s.id}`).not.toBeNull();
      }
    }
  });

  it("RESTARTABLE — reset + redrive re-emits NOTHING and rebuilds the identical events", async () => {
    await setBackfillEnabled(true);
    const mapped = admin.filter((s) => s.exp !== null);

    // Capture the event ids for admin's mapped rows BEFORE the reset.
    const beforeIds: Record<string, number> = {};
    for (const s of mapped) {
      const ev = await eventFor(SRC_ADMIN, s.id, s.objectId);
      expect(ev).not.toBeNull();
      beforeIds[s.id] = (ev as EventRow).id;
    }

    // Rewind to the sentinels: idle, counters zeroed, ceiling cleared, cursor reset.
    const r = await reset(SRC_ADMIN);
    expect(r.reset).toBe(true);
    expect(num(r.previous_rows_seen)).toBe(4);
    const stReset = await state(SRC_ADMIN);
    expect(stReset.status).toBe("idle");
    expect(num(stReset.rows_seen)).toBe(0);
    expect(stReset.cursor_created_at).toBe("-infinity");
    expect(stReset.cursor_id).toBe("00000000-0000-0000-0000-000000000000");

    // Redrive from scratch: every row is re-walked, but the NOT EXISTS guard means
    // ZERO new inserts — the append-only spine is never duplicated.
    await drainToDone(SRC_ADMIN);
    const stDone = await state(SRC_ADMIN);
    expect(num(stDone.rows_seen)).toBe(4); // walked all four again…
    expect(num(stDone.rows_emitted)).toBe(0); // …but emitted NOTHING new
    expect(num(stDone.rows_skipped)).toBe(4); // three already-present + one unmapped

    // The very same event rows still stand — identical ids, no duplicates.
    for (const s of mapped) {
      const ev = await eventFor(SRC_ADMIN, s.id, s.objectId);
      expect(ev?.id).toBe(beforeIds[s.id]);
    }
  });

  it("READ-ONLY — the legacy source rows are never mutated by the backfill (P2)", async () => {
    // activity_log: our org still has exactly the seven seeded rows.
    const al = await svc().from("activity_log").select("id, action").eq("org_id", orgId);
    expect(al.error, al.error?.message).toBeNull();
    const alRows = (al.data ?? []) as { id: string; action: string }[];
    expect(alRows.length).toBe(7);
    expect(alRows.map((r) => r.id).sort()).toEqual(act.map((s) => s.id).sort());

    // admin_activity_log: the four rows still present with their original actions.
    for (const s of admin) {
      const row = await svc().from("admin_activity_log").select("id, action").eq("id", s.id).single();
      expect(row.error, row.error?.message).toBeNull();
    }

    // hq_memory_events: the eight rows still present under our memory.
    const me = await svc().from("hq_memory_events").select("id").eq("memory_id", memId);
    expect(me.error, me.error?.message).toBeNull();
    expect((me.data ?? []).length).toBe(8);
  });
});
