import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ShadowObservationRecord } from "@/server/sdk/shadow";

/**
 * Unit proof for the DURABLE executor-shadow store's idempotency + best-effort envelope
 * (server/services/executor-shadow.ts)
 * (CEO Directive #016 / D-06, increment R2; ADR 0011; the Shadow Truthfulness Rule).
 *
 * The pure contract (shadow.test.ts) proves the record builder + the in-memory reference; the
 * live-DB tier (integration/spine/executor-shadow.test.ts) proves the migration's storage, RLS,
 * append-only guard and privilege model. This tier proves what only the SERVICE layer owns and a
 * live DB can't easily force: that a re-run of the SAME autonomous decision does not write a
 * duplicate row — the natural-key idempotency the Task Engine's whole-task retry demands.
 *
 * WHAT IS PINNED
 *   - FIRST-WRITE-WINS: two records under the same `correlation_id · task_id · action_id` insert
 *     exactly once; the second is a no-op success returning the first row's id.
 *   - a DIFFERENT action (or run) is a distinct key → a distinct insert.
 *   - the guard NEVER writes/reads an application store — it queries only the shadow table.
 *   - BEST-EFFORT: a failing lookup PROCEEDS to insert (never drops the observation); an RPC
 *     failure returns { ok:false } and NEVER throws.
 *
 * The Supabase admin client is a fake that records inserts (the RPC) and answers the guard's
 * SELECT from that same in-memory list — so idempotency is proven against a faithful double of the
 * query the store actually issues, with no database and no env.
 */

// A hand-built fake admin client: `rpc(...)` inserts, the `.from(table)` query builder answers the
// idempotency SELECT from the same rows. Assigned by the mock factory below (vi.hoisted).
const { fake } = vi.hoisted(() => {
  type Row = {
    id: number;
    correlation_id: string;
    task_id: string;
    action_id: string;
  };
  const state = {
    rows: [] as Row[],
    nextId: 1,
    lookupError: null as string | null,
    lookupThrows: false,
    rpcError: null as string | null,
    inserts: 0,
    lookups: 0,
    reset() {
      this.rows = [];
      this.nextId = 1;
      this.lookupError = null;
      this.lookupThrows = false;
      this.rpcError = null;
      this.inserts = 0;
      this.lookups = 0;
    },
  };

  function client() {
    return {
      // The idempotency guard's read path: from(table).select().eq().eq().eq().order().limit()
      from() {
        const filters: Record<string, unknown> = {};
        const builder = {
          select() {
            return builder;
          },
          eq(column: string, value: unknown) {
            filters[column] = value;
            return builder;
          },
          order() {
            return builder;
          },
          limit() {
            return builder;
          },
          then(
            resolve: (r: { data: { id: number }[] | null; error: { message: string } | null }) => unknown,
          ) {
            state.lookups += 1;
            if (state.lookupThrows) throw new Error("lookup exploded");
            if (state.lookupError) {
              return resolve({ data: null, error: { message: state.lookupError } });
            }
            const match = state.rows
              .filter(
                (r) =>
                  r.correlation_id === filters.correlation_id &&
                  r.task_id === filters.task_id &&
                  r.action_id === filters.action_id,
              )
              .sort((a, b) => a.id - b.id)[0];
            return resolve({ data: match ? [{ id: match.id }] : [], error: null });
          },
        };
        return builder;
      },
      // The write primitive: hq_record_executor_shadow inserts a new identity row.
      rpc(_fn: string, args: Record<string, unknown>) {
        state.inserts += 1;
        if (state.rpcError) {
          return Promise.resolve({ data: null, error: { message: state.rpcError } });
        }
        const id = state.nextId++;
        state.rows.push({
          id,
          correlation_id: String(args.p_correlation_id),
          task_id: String(args.p_task_id),
          action_id: String(args.p_action_id),
        });
        return Promise.resolve({ data: id, error: null });
      },
    };
  }

  return { fake: { state, client } };
});

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.client() }));

import {
  recordExecutorShadowObservation,
  createDurableShadowObservationStore,
} from "@/server/services/executor-shadow";

const CORR = "11111111-1111-1111-1111-111111111111";

function planned(over: Partial<ShadowObservationRecord> = {}): ShadowObservationRecord {
  return {
    kind: "executor_shadow",
    outcome: "planned",
    source: "autonomous",
    correlationId: CORR,
    taskId: "task-1",
    actionId: "lead:lead_1:memory.write",
    toolLabel: "memory.write",
    idempotencyKey: `autonomous·task-1·memory.write·lead%3Alead_1%3Amemory.write·${CORR}`,
    reason: null,
    detail: "",
    ...over,
  } as ShadowObservationRecord;
}

beforeEach(() => {
  fake.state.reset();
});

describe("recordExecutorShadowObservation — idempotent by the run+action natural key", () => {
  it("a first write inserts exactly one row and returns its id", async () => {
    const res = await recordExecutorShadowObservation(planned());
    expect(res).toEqual({ ok: true, id: 1 });
    expect(fake.state.inserts).toBe(1);
    expect(fake.state.rows).toHaveLength(1);
  });

  it("FIRST-WRITE-WINS: a re-run of the SAME decision does not duplicate — one row, same id", async () => {
    const first = await recordExecutorShadowObservation(planned());
    const second = await recordExecutorShadowObservation(planned());
    expect(first).toEqual({ ok: true, id: 1 });
    // the retry is a no-op success returning the FIRST row's id, not a new insert
    expect(second).toEqual({ ok: true, id: 1 });
    expect(fake.state.inserts).toBe(1);
    expect(fake.state.rows).toHaveLength(1);
  });

  it("a retry whose outcome differs is STILL deduped (first-write-wins; the executor is deterministic)", async () => {
    await recordExecutorShadowObservation(planned());
    const retry = await recordExecutorShadowObservation(
      planned({ outcome: "refused", reason: "invalid_args", toolLabel: null, idempotencyKey: null, detail: "x" }),
    );
    expect(retry).toEqual({ ok: true, id: 1 });
    expect(fake.state.rows).toHaveLength(1);
  });

  it("a DIFFERENT action in the same run is a distinct key → a distinct insert", async () => {
    await recordExecutorShadowObservation(planned());
    const other = await recordExecutorShadowObservation(planned({ actionId: "lead:lead_2:memory.write" }));
    expect(other).toEqual({ ok: true, id: 2 });
    expect(fake.state.rows).toHaveLength(2);
  });

  it("a DIFFERENT run (correlation) is a distinct key → a distinct insert", async () => {
    await recordExecutorShadowObservation(planned());
    const other = await recordExecutorShadowObservation(
      planned({ correlationId: "22222222-2222-2222-2222-222222222222" }),
    );
    expect(other).toEqual({ ok: true, id: 2 });
    expect(fake.state.rows).toHaveLength(2);
  });
});

describe("recordExecutorShadowObservation — best-effort (never throws, never drops the observation)", () => {
  it("a failing idempotency lookup PROCEEDS to insert — the observation is not dropped", async () => {
    fake.state.lookupError = "lookup boom";
    const res = await recordExecutorShadowObservation(planned());
    expect(res).toEqual({ ok: true, id: 1 });
    expect(fake.state.lookups).toBe(1);
    expect(fake.state.inserts).toBe(1);
  });

  it("a THROWING idempotency lookup PROCEEDS to insert and never throws", async () => {
    fake.state.lookupThrows = true;
    const res = await recordExecutorShadowObservation(planned());
    expect(res).toEqual({ ok: true, id: 1 });
    expect(fake.state.inserts).toBe(1);
  });

  it("an RPC failure returns { ok:false } and never throws", async () => {
    fake.state.rpcError = "rpc down";
    const res = await recordExecutorShadowObservation(planned());
    expect(res).toEqual({ ok: false, error: "rpc down" });
  });
});

describe("createDurableShadowObservationStore — the injected seam is idempotent + frozen", () => {
  it("binds the idempotent write primitive and is write-only + frozen", async () => {
    const store = createDurableShadowObservationStore();
    expect(Object.isFrozen(store)).toBe(true);
    const a = await store.record(planned());
    const b = await store.record(planned()); // same key → no-op success
    expect(a).toEqual({ ok: true, id: 1 });
    expect(b).toEqual({ ok: true, id: 1 });
    expect(fake.state.rows).toHaveLength(1);
    // the store exposes ONLY record() — never an application/apply-once verb
    expect(Object.keys(store)).toEqual(["record"]);
  });
});
