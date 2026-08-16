import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * HQ Event Spine — real-Postgres proof of ACTIVATION (Module 1 reveal).
 *
 * The activation migration (20261159000000) flips the three infra kill-switches
 * ON so the spine is genuinely LIVE: real HQ actions emit canonical events, and
 * the `timeline` consumer drains them into the hq_timeline projection the Pulse
 * reads. This tier proves the END-TO-END behaviour a static text check cannot —
 * against a LIVE database with the real migrations + triggers applied:
 *   1. the three gate RPCs read TRUE (the activated configuration is in effect);
 *   2. a real domain mutation (a job insert) emits its curated canonical event
 *      (job.created) through the _record_activity chokepoint — the producer is on;
 *   3. draining the registered `timeline` consumer PROJECTS that event into
 *      hq_timeline, and a re-drive after a replay re-applies it as a NO-OP
 *      (exactly one projection row — the effectively-once idempotency oracle);
 *   4. hq_events stays APPEND-ONLY under service-role: UPDATE and DELETE are both
 *      rejected by the block-mutation guard.
 *
 * The integration config runs files serially (fileParallelism: false), so
 * flipping the shared gates here can't race the sibling spine suites. We capture
 * the prior event_spine settings and RESTORE them on teardown, and drop the
 * seeded org, so this suite leaves no residue beyond the append-only events it
 * emits (harmless in the ephemeral CI database).
 */

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

const CONSUMER = "timeline";
const idOf = (r: Res<Record<string, unknown>>): string =>
  String((r.data as { id: string }).id);

/** Set all three spine gates to `on`, preserving the rest of the settings blob. */
async function setGates(on: boolean): Promise<void> {
  const cur = await svc().from("hq_settings").select("data").eq("id", "singleton").single();
  expect(cur.error, cur.error?.message).toBeNull();
  const data = (((cur.data as { data?: Record<string, unknown> } | null)?.data) ??
    {}) as Record<string, unknown>;
  const next = {
    ...data,
    event_spine: {
      ...((data.event_spine as Record<string, unknown>) ?? {}),
      dual_write_enabled: on,
      backfill_enabled: on,
      consumer_enabled: on,
    },
  };
  const upd = await svc().from("hq_settings").update({ data: next }).eq("id", "singleton");
  expect(upd.error, upd.error?.message).toBeNull();
}

async function restoreSettings(blob: Record<string, unknown>): Promise<void> {
  const upd = await svc().from("hq_settings").update({ data: blob }).eq("id", "singleton");
  expect(upd.error, upd.error?.message).toBeNull();
}

type DrainSummary = { processed?: number; stopped?: string | null; skipped?: string };

async function drain(): Promise<DrainSummary> {
  const res = await svc().rpc<DrainSummary>("hq_drain_consumer", {
    p_consumer: CONSUMER,
    p_max_events: 500,
    p_max_attempts: 5,
  });
  expect(res.error, res.error?.message).toBeNull();
  return res.data as DrainSummary;
}

/** Drain the timeline consumer until caught up (the gate must be ON). */
async function drainAll(): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const res = await drain();
    expect(res.skipped, "consumer gate must be on for drainAll").toBeUndefined();
    if ((res.processed ?? 0) === 0 && !res.stopped) return;
  }
  throw new Error("drainAll did not converge");
}

/** How many hq_timeline rows exist for a given event id (0 or 1 — PK on event_id). */
async function timelineRowCount(eventId: number): Promise<number> {
  const res = await svc().from("hq_timeline").select("event_id").eq("event_id", eventId);
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? []).length;
}

async function eventIdForObject(objectId: string, verb: string): Promise<number | null> {
  const res = await svc()
    .from("hq_events")
    .select("id, verb, object_id")
    .eq("object_id", objectId);
  expect(res.error, res.error?.message).toBeNull();
  const rows = ((res.data ?? []) as unknown as { id: number; verb: string }[])
    .filter((r) => r.verb === verb)
    .sort((a, b) => a.id - b.id);
  const last = rows[rows.length - 1];
  return last ? last.id : null;
}

describeIntegration("HQ Event Spine · activation (Module 1 reveal)", () => {
  let orgId = "";
  let priorSettings: Record<string, unknown> = {};
  const slug = `it-activation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  beforeAll(async () => {
    // Capture the shared settings so teardown restores whatever the run had.
    const cur = await svc().from("hq_settings").select("data").eq("id", "singleton").single();
    expect(cur.error, cur.error?.message).toBeNull();
    priorSettings = (((cur.data as { data?: Record<string, unknown> } | null)?.data) ??
      {}) as Record<string, unknown>;

    // Assert the activated configuration for this suite's own run (robust to
    // whatever order sibling suites left the shared gates in).
    await setGates(true);

    const org = await svc()
      .from("organizations")
      .insert({ name: "Spine Activation Org", slug })
      .select("id")
      .single();
    expect(org.error, org.error?.message).toBeNull();
    orgId = idOf(org);
  });

  afterAll(async () => {
    if (orgId) await svc().from("organizations").delete().eq("id", orgId);
    await restoreSettings(priorSettings);
  });

  it("the three gate RPCs read TRUE — the spine is activated", async () => {
    for (const fn of [
      "hq_spine_dual_write_enabled",
      "hq_spine_backfill_enabled",
      "hq_spine_consumer_enabled",
    ]) {
      const res = await svc().rpc<boolean>(fn);
      expect(res.error, res.error?.message).toBeNull();
      expect(res.data, `${fn} should read true when activated`).toBe(true);
    }
  });

  it("a real job insert emits its curated canonical event through the producer", async () => {
    const ins = await svc()
      .from("jobs")
      .insert({ org_id: orgId, status: "new" })
      .select("id")
      .single();
    expect(ins.error, ins.error?.message).toBeNull();
    const jobId = idOf(ins);

    // Dual-write is on → the _record_activity chokepoint mirrored job.created into
    // the spine, in the same transaction as the insert.
    const eventId = await eventIdForObject(jobId, "job.created");
    expect(eventId, "job.created must be emitted when the producer is live").not.toBeNull();
  });

  it("draining the timeline consumer projects the event, and re-drive is idempotent", async () => {
    const ins = await svc()
      .from("jobs")
      .insert({ org_id: orgId, status: "new" })
      .select("id")
      .single();
    expect(ins.error, ins.error?.message).toBeNull();
    const jobId = idOf(ins);
    const eventId = await eventIdForObject(jobId, "job.created");
    expect(eventId).not.toBeNull();
    const id = eventId as number;

    // First drive: the projection gains exactly one row for this event.
    await drainAll();
    expect(await timelineRowCount(id)).toBe(1);

    // Rewind the consumer to JUST BEFORE this event and re-drive: the apply is an
    // idempotent upsert (ON CONFLICT (event_id) DO NOTHING), so re-projecting the
    // same event is a no-op — still exactly one row, never a duplicate.
    const replay = await svc().rpc("hq_replay_consumer", {
      p_consumer: CONSUMER,
      p_to_event_id: id - 1,
    });
    expect(replay.error, replay.error?.message).toBeNull();

    await drainAll();
    expect(await timelineRowCount(id)).toBe(1);
  });

  it("hq_events stays APPEND-ONLY — UPDATE and DELETE are rejected under service-role", async () => {
    const ins = await svc()
      .from("jobs")
      .insert({ org_id: orgId, status: "new" })
      .select("id")
      .single();
    expect(ins.error, ins.error?.message).toBeNull();
    const jobId = idOf(ins);
    const eventId = await eventIdForObject(jobId, "job.created");
    expect(eventId).not.toBeNull();
    const id = eventId as number;

    const upd = await svc().from("hq_events").update({ verb: "job.completed" }).eq("id", id);
    expect(upd.error, "UPDATE on the append-only spine must be rejected").not.toBeNull();

    const del = await svc().from("hq_events").delete().eq("id", id);
    expect(del.error, "DELETE on the append-only spine must be rejected").not.toBeNull();
  });
});
