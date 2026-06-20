import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * HQ Event Spine — real-Postgres proof of PR1 (Module 1).
 *
 * The unit tier proves emitEvent()'s envelope mapping against a mocked RPC; this
 * tier proves the BEHAVIOUR the mock can't: that the migration's storage, RLS,
 * append-only guard, partition-level RLS and privilege model actually hold in a
 * live database ("mocks prove intent; real infrastructure proves behaviour").
 *
 * It runs only against a live DB (describeIntegration): skipped locally with no
 * database, FAILED loudly in CI if the database is missing.
 *
 * Note: hq_events is append-only — even service_role cannot DELETE — so these
 * tests intentionally leave their rows behind. That is harmless in the ephemeral
 * CI database (`supabase start`), and proving exactly that is test §5.
 */

// hq_events / hq_emit_event are service-role-only spine internals and are NOT in
// the generated Database types. Cast the typed client to the minimal surface this
// suite exercises (same `as unknown as` convention the HQ services use for the
// untyped hq_* tables) rather than reaching for `any`.
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type Filterable<T> = Term<T> & { eq(column: string, value: unknown): Term<T> };
type SpineTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown>): Filterable<null>;
  update(patch: Record<string, unknown>): Filterable<null>;
  delete(): Filterable<null>;
};
type SpineClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): SpineTable;
};

const svc = (): SpineClient => serviceClient() as unknown as SpineClient;
const anon = (): SpineClient => anonClient() as unknown as SpineClient;

/** Build a valid envelope for hq_emit_event with a caller-supplied correlation id. */
function emitArgs(
  correlationId: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    p_actor_type: "system",
    p_actor_id: "spine-integration",
    p_verb: "system.cron_ran",
    p_object_type: "system",
    p_object_id: "spine-it",
    p_correlation_id: correlationId,
    ...over,
  };
}

/** The current UTC month's partition name, e.g. `hq_events_2026_06`. */
function currentMonthPartition(): string {
  const d = new Date();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `hq_events_${d.getUTCFullYear()}_${m}`;
}

/**
 * Assert an anon read obtained no spine row — denial being equally valid whether
 * it arrives as a hard privilege error or as an RLS-filtered empty set. The
 * security property is identical: the unauthenticated caller sees nothing. A
 * returned row is the only failure.
 */
function expectAnonDenied(res: RpcResult<Record<string, unknown>[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

describeIntegration("HQ Event Spine · hq_events (PR1)", () => {
  it("service_role emits through hq_emit_event and reads the rows back; id is monotonic", async () => {
    const correlationId = crypto.randomUUID();

    const first = await svc().rpc<number>("hq_emit_event", emitArgs(correlationId));
    expect(first.error, first.error?.message).toBeNull();
    expect(typeof first.data).toBe("number");
    const id1 = Number(first.data);
    expect(id1).toBeGreaterThan(0);

    const second = await svc().rpc<number>(
      "hq_emit_event",
      emitArgs(correlationId, { p_verb: "system.alert_raised", p_severity: "warn" }),
    );
    expect(second.error, second.error?.message).toBeNull();
    const id2 = Number(second.data);
    // The parent identity sequence is THE total order — strictly increasing.
    expect(id2).toBeGreaterThan(id1);

    const read = await svc()
      .from("hq_events")
      .select("id, verb, actor_type, correlation_id")
      .eq("correlation_id", correlationId);
    expect(read.error, read.error?.message).toBeNull();
    expect(read.data).toHaveLength(2);
    const verbs = (read.data ?? []).map((r) => r.verb).sort();
    expect(verbs).toEqual(["system.alert_raised", "system.cron_ran"]);
  });

  it("anon cannot read hq_events (parent) — RLS:hq denies every JWT client", async () => {
    const correlationId = crypto.randomUUID();
    const emit = await svc().rpc<number>("hq_emit_event", emitArgs(correlationId));
    expect(emit.error, emit.error?.message).toBeNull();

    const read = await anon()
      .from("hq_events")
      .select("id")
      .eq("correlation_id", correlationId);
    expectAnonDenied(read);
  });

  it("anon cannot read the partition directly (parent RLS is NOT inherited)", async () => {
    // The load-bearing partition test: the emitted row lands in the current-month
    // partition. service_role reads it THROUGH the partition name; anon is denied
    // AT the partition — proving we enabled RLS on the partition, not just the
    // parent (the PostgREST pitfall the migration's SECURITY NOTE calls out).
    const correlationId = crypto.randomUUID();
    const emit = await svc().rpc<number>("hq_emit_event", emitArgs(correlationId));
    expect(emit.error, emit.error?.message).toBeNull();

    const part = currentMonthPartition();
    const asService = await svc()
      .from(part)
      .select("id, correlation_id")
      .eq("correlation_id", correlationId);
    expect(asService.error, asService.error?.message).toBeNull();
    expect(asService.data).toHaveLength(1);

    const asAnon = await anon().from(part).select("id").eq("correlation_id", correlationId);
    expectAnonDenied(asAnon);

    // The DEFAULT catch-all exists and is queryable by service_role (empty in
    // normal operation because the runway covers every current month).
    const def = await svc().from("hq_events_default").select("id");
    expect(def.error, def.error?.message).toBeNull();
  });

  it("anon cannot call hq_emit_event — EXECUTE is service_role-only", async () => {
    const res = await anon().rpc<number>("hq_emit_event", emitArgs(crypto.randomUUID()));
    expect(res.error).not.toBeNull();
    expect(res.data).toBeNull();
  });

  it("hq_events is append-only — UPDATE and DELETE are rejected even for service_role", async () => {
    const correlationId = crypto.randomUUID();
    const emit = await svc().rpc<number>("hq_emit_event", emitArgs(correlationId));
    expect(emit.error, emit.error?.message).toBeNull();

    const updated = await svc()
      .from("hq_events")
      .update({ severity: "critical" })
      .eq("correlation_id", correlationId);
    expect(updated.error, "UPDATE must be blocked by the append-only guard").not.toBeNull();

    const deleted = await svc()
      .from("hq_events")
      .delete()
      .eq("correlation_id", correlationId);
    expect(deleted.error, "DELETE must be blocked by the append-only guard").not.toBeNull();

    // The row survived both attempts — still exactly one, unchanged.
    const read = await svc()
      .from("hq_events")
      .select("id, severity")
      .eq("correlation_id", correlationId);
    expect(read.data).toHaveLength(1);
    expect(read.data?.[0]?.severity).toBe("info");
  });

  it("hq_create_events_partition is idempotent and UTC-deterministically named", async () => {
    // A far-future month outside the pre-created runway, so the first call creates
    // and the second is a no-op — both returning the same UTC-derived name.
    const anchor = new Date(Date.UTC(2027, 2, 15, 12, 0, 0)).toISOString(); // March 2027

    const created = await svc().rpc<string>("hq_create_events_partition", { p_anchor: anchor });
    expect(created.error, created.error?.message).toBeNull();
    expect(created.data).toBe("hq_events_2027_03");

    const again = await svc().rpc<string>("hq_create_events_partition", { p_anchor: anchor });
    expect(again.error, again.error?.message).toBeNull();
    expect(again.data).toBe("hq_events_2027_03");
  });

  it("anon cannot read hq_event_consumers or dead_events (both RLS:hq)", async () => {
    const consumer = `it-consumer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Seed real rows so the denial is meaningful (an empty table denies everyone).
    const seedOffset = await svc()
      .from("hq_event_consumers")
      .insert({ consumer, last_event_id: 7 });
    expect(seedOffset.error, seedOffset.error?.message).toBeNull();
    const seedDead = await svc()
      .from("dead_events")
      .insert({ consumer, event_id: 1, error: "probe" });
    expect(seedDead.error, seedDead.error?.message).toBeNull();

    // service_role sees them…
    const offsetAsService = await svc()
      .from("hq_event_consumers")
      .select("consumer, last_event_id")
      .eq("consumer", consumer);
    expect(offsetAsService.data).toHaveLength(1);

    // …anon does not.
    expectAnonDenied(
      await anon().from("hq_event_consumers").select("consumer").eq("consumer", consumer),
    );
    expectAnonDenied(await anon().from("dead_events").select("id").eq("consumer", consumer));

    // These two are mutable (not append-only) — clean up after ourselves.
    await svc().from("dead_events").delete().eq("consumer", consumer);
    await svc().from("hq_event_consumers").delete().eq("consumer", consumer);
  });
});
