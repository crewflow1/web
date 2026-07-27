import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * HQ Event Spine — real-Postgres proof of PR3 (Offset Consumer).
 *
 * PR3 lands the consumer side of the spine: a generic SQL drainer that reads new
 * events since a durable offset, applies each idempotently, and advances the
 * offset in the SAME transaction (D1, Ch.04). This tier proves the BEHAVIOUR a
 * mock cannot — against a LIVE database, with the real migration applied:
 *   1. it ships DARK — with the global gate off, draining is a no-op;
 *   2. with the gate on it drains in id-order and applies idempotently;
 *   3. it NEVER processes an event twice — a re-drain advances nothing;
 *   4. REPLAY is deterministic — drop the projection, rewind the offset, redrive,
 *      and the read-model is byte-identical (the bible's effectively-once oracle);
 *   5. a POISON event is dead-lettered after N attempts, the offset advances past
 *      it (one bad event never blocks the stream), and a system.alert_raised fires;
 *   6. the golden signals (throughput, per-consumer lag, dead-event count) read out.
 *
 * Events are written directly through the PR1 entry point `hq_emit_event` (not the
 * PR2 producer path) so the consumer is proven in isolation. The selftest consumer
 * `__spine_selftest__` is the engine's conformance fixture: a naturally-idempotent
 * projection keyed by (consumer, event_id).
 *
 * Runs only against a live DB (describeIntegration). hq_events is append-only so
 * emitted events are left behind (harmless in the ephemeral CI database); we clean
 * our own consumer/projection/dead/retry rows and return the gate to DARK.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Thenable<T> = PromiseLike<Res<T>>;
interface Sel extends Thenable<Record<string, unknown>[]> {
  eq(column: string, value: unknown): Sel;
}
interface Del extends Thenable<null> {
  eq(column: string, value: unknown): Del;
}
interface Upd extends Thenable<null> {
  eq(column: string, value: unknown): Upd;
}
interface Table {
  select(columns?: string): Sel;
  delete(): Del;
  update(patch: Record<string, unknown>): Upd;
}
interface Client {
  rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Thenable<T>;
  from(table: string): Table;
}
const svc = (): Client => serviceClient() as unknown as Client;

const CONSUMER = "__spine_selftest__";

type GoldenSignals = {
  max_event_id: number;
  throughput: { last_1m: number; last_1h: number; last_24h: number };
  consumers: { consumer: string; last_event_id: number; lag: number }[];
  dead_event_count: number;
  retry_backlog: number;
};

type DrainSummary = {
  consumer: string;
  processed?: number;
  dead_lettered?: number;
  new_offset?: number;
  lag?: number;
  stopped?: string | null;
  skipped?: string;
};

/** Emit one event through the PR1 validated entry point; returns its bigint id. */
async function emit(over: Record<string, unknown> = {}): Promise<number> {
  const res = await svc().rpc<number | string>("hq_emit_event", {
    p_actor_type: "system",
    p_actor_id: "pr3-consumer-it",
    p_verb: "system.cron_ran",
    p_object_type: "system",
    p_object_id: "pr3-it",
    p_correlation_id: crypto.randomUUID(),
    ...over,
  });
  expect(res.error, res.error?.message).toBeNull();
  return Number(res.data);
}

async function golden(): Promise<GoldenSignals> {
  const res = await svc().rpc<GoldenSignals>("hq_spine_golden_signals");
  expect(res.error, res.error?.message).toBeNull();
  return res.data as GoldenSignals;
}

async function drain(maxAttempts = 5, maxEvents = 500): Promise<DrainSummary> {
  const res = await svc().rpc<DrainSummary>("hq_drain_consumer", {
    p_consumer: CONSUMER,
    p_max_events: maxEvents,
    p_max_attempts: maxAttempts,
  });
  expect(res.error, res.error?.message).toBeNull();
  return res.data as DrainSummary;
}

async function replay(toEventId: number): Promise<void> {
  const res = await svc().rpc("hq_replay_consumer", {
    p_consumer: CONSUMER,
    p_to_event_id: toEventId,
  });
  expect(res.error, res.error?.message).toBeNull();
}

async function register(startEventId: number): Promise<void> {
  const res = await svc().rpc("hq_consumer_register", {
    p_consumer: CONSUMER,
    p_start_event_id: startEventId,
  });
  expect(res.error, res.error?.message).toBeNull();
}

/** The current offset for our consumer. */
async function offset(): Promise<number> {
  const res = await svc()
    .from("hq_event_consumers")
    .select("last_event_id")
    .eq("consumer", CONSUMER);
  expect(res.error, res.error?.message).toBeNull();
  return Number((res.data?.[0] as { last_event_id: number } | undefined)?.last_event_id ?? -1);
}

/** Event ids the selftest projection has recorded for our consumer. */
async function selftestIds(): Promise<number[]> {
  const res = await svc()
    .from("hq_consumer_selftest")
    .select("event_id")
    .eq("consumer", CONSUMER);
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? []).map((r) => Number((r as { event_id: number }).event_id));
}

async function deadIds(): Promise<number[]> {
  const res = await svc().from("dead_events").select("event_id").eq("consumer", CONSUMER);
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? []).map((r) => Number((r as { event_id: number }).event_id));
}

/** Flip the global consumer gate, preserving the rest of the hq_settings blob. */
async function setConsumerEnabled(on: boolean): Promise<void> {
  const cur = await svc().from("hq_settings").select("data").eq("id", "singleton");
  expect(cur.error, cur.error?.message).toBeNull();
  const data = ((cur.data?.[0] as { data?: Record<string, unknown> } | undefined)?.data ??
    {}) as Record<string, unknown>;
  const next = {
    ...data,
    event_spine: {
      ...((data.event_spine as Record<string, unknown>) ?? {}),
      consumer_enabled: on,
    },
  };
  const upd = await svc().from("hq_settings").update({ data: next }).eq("id", "singleton");
  expect(upd.error, upd.error?.message).toBeNull();
}

async function cleanConsumerState(): Promise<void> {
  await svc().from("hq_consumer_selftest").delete().eq("consumer", CONSUMER);
  await svc().from("dead_events").delete().eq("consumer", CONSUMER);
  await svc().from("hq_consumer_retries").delete().eq("consumer", CONSUMER);
  await svc().from("hq_event_consumers").delete().eq("consumer", CONSUMER);
}

describeIntegration("HQ Event Spine · offset consumer (PR3)", () => {
  let baseline = 0;

  beforeAll(async () => {
    baseline = (await golden()).max_event_id;
    await cleanConsumerState();
    await register(baseline); // only process events emitted by THIS suite
    await setConsumerEnabled(false);
  });

  afterAll(async () => {
    await setConsumerEnabled(false);
    await cleanConsumerState();
  });

  it("ships DARK — gate off: draining is a no-op (consumer_disabled)", async () => {
    await setConsumerEnabled(false);
    const e = await emit({ p_object_id: "dark" });
    const res = await drain();
    expect(res.skipped).toBe("consumer_disabled");
    expect(await selftestIds()).not.toContain(e);
    expect(await offset()).toBe(baseline); // untouched
  });

  it("gate on — drains in id-order, applies, and advances the offset to caught-up", async () => {
    await setConsumerEnabled(true);
    const e1 = await emit();
    const e2 = await emit();
    const e3 = await emit();

    const res = await drain();
    expect(res.skipped).toBeUndefined();
    expect(res.processed ?? 0).toBeGreaterThanOrEqual(3);

    const ids = await selftestIds();
    expect(ids).toEqual(expect.arrayContaining([e1, e2, e3]));

    // The offset has caught up to the head of the log.
    expect(await offset()).toBe((await golden()).max_event_id);
  });

  it("NEVER processes an event twice — an immediate re-drain advances nothing", async () => {
    const before = await offset();
    const res = await drain();
    expect(res.processed ?? 0).toBe(0);
    expect(Number(res.new_offset)).toBe(before);

    // Every recorded event appears exactly once (the PK + strict order guarantee).
    const ids = await selftestIds();
    const dupes = ids.filter((v, i) => ids.indexOf(v) !== i);
    expect(dupes).toEqual([]);
  });

  it("REPLAY is deterministic — drop + rewind + redrive rebuilds an identical read-model", async () => {
    const before = (await selftestIds()).slice().sort((a, b) => a - b);
    expect(before.length).toBeGreaterThan(0);

    // Drop the projection for this consumer…
    await svc().from("hq_consumer_selftest").delete().eq("consumer", CONSUMER);
    expect(await selftestIds()).toHaveLength(0);

    // …rewind the offset to the suite baseline and redrive.
    await replay(baseline);
    expect(await offset()).toBe(baseline);
    await drain();

    const after = (await selftestIds()).slice().sort((a, b) => a - b);
    expect(after).toEqual(before); // byte-identical oracle
  });

  it("DEAD-LETTERS a poison event after N attempts, advances past it, and alerts", async () => {
    await drain(); // catch up first
    const offsetBeforePoison = await offset();

    const poison = await emit({ p_object_id: "poison", p_payload: { __poison__: true } });
    const good = await emit({ p_object_id: "after-poison" });

    // Attempt 1 (threshold 2): the apply throws, so the batch STOPS at the poison
    // event — head-of-line — without advancing past it.
    const first = await drain(2);
    expect(first.stopped).toBe("retry_pending");
    expect(Number(first.new_offset)).toBe(offsetBeforePoison);
    expect(await deadIds()).not.toContain(poison);

    // Attempt 2 reaches the threshold: the poison event is parked, the offset
    // advances past it, and the good event behind it is finally processed.
    const second = await drain(2);
    expect(second.dead_lettered ?? 0).toBeGreaterThanOrEqual(1);
    expect(await deadIds()).toContain(poison);
    const ids = await selftestIds();
    expect(ids).toContain(good);
    expect(ids).not.toContain(poison);
    expect(await offset()).toBeGreaterThanOrEqual(good);

    // A critical system.alert_raised was emitted for this consumer (through the
    // validated entry point, not a raw insert).
    const alerts = await svc()
      .from("hq_events")
      .select("verb, object_id, severity, payload")
      .eq("verb", "system.alert_raised")
      .eq("object_id", CONSUMER);
    expect(alerts.error, alerts.error?.message).toBeNull();
    expect((alerts.data ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it("exposes golden signals — throughput, per-consumer lag, dead-event count", async () => {
    const g = await golden();
    expect(g.max_event_id).toBeGreaterThan(baseline);
    expect(g.throughput.last_1m).toBeGreaterThanOrEqual(5); // this suite's emits
    expect(g.dead_event_count).toBeGreaterThanOrEqual(1); // the poison event

    const mine = g.consumers.find((c) => c.consumer === CONSUMER);
    expect(mine).toBeDefined();
    expect(typeof mine?.lag).toBe("number");
    expect(mine?.lag ?? -1).toBeGreaterThanOrEqual(0);
  });
});
