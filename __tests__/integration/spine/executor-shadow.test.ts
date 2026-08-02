import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

// createAdminClient (the durable store's client) reads NEXT_PUBLIC_SUPABASE_URL; the harness
// resolves either NEXT_PUBLIC_SUPABASE_URL or the bare SUPABASE_URL. Mirror the bare value into
// the NEXT_PUBLIC name so the real store binds to the SAME local database the harness guards —
// set BEFORE importing the server-only store, which snapshots nothing but reads env per call.
process.env.NEXT_PUBLIC_SUPABASE_URL ??= process.env.SUPABASE_URL;
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= process.env.SUPABASE_ANON_KEY;

import { createDurableShadowObservationStore } from "@/server/services/executor-shadow";
import { shadowObservationRecord, type ShadowObservationContext } from "@/server/sdk/shadow";

/**
 * Executor-shadow durable store — real-Postgres proof of Directive #016 R2 (Module: Live Executor
 * Rollout).
 *
 * The unit tier proves the pure record builder + the service's envelope mapping against an
 * in-memory / mocked RPC; this tier proves the BEHAVIOUR the mocks can't — that the migration's
 * storage, RLS, append-only guard, privilege model AND the Shadow Truthfulness Rule's two DB-level
 * guarantees actually hold in a live database ("mocks prove intent; real infrastructure proves
 * behaviour"):
 *
 *   • the row is unforgeably labelled `kind = 'executor_shadow'` — the write function has no
 *     `p_kind` parameter (it is hardcoded) and the column CHECK rejects any other literal;
 *   • the table CANNOT hold an application status — `outcome` is CHECKed to the shadow's own
 *     vocabulary, so an `applied` outcome is rejected by the database itself.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED
 * loudly in CI if the database is missing. The table is append-only (even service_role cannot
 * DELETE), so these tests intentionally leave their rows behind — harmless in the ephemeral CI
 * database, and proving exactly that is one of the tests below.
 */

// hq_ai_executor_shadow_observations / hq_record_executor_shadow are service-role-only internals
// and are NOT in the generated Database types. Cast to the minimal surface this suite exercises
// (the same `as unknown as` convention the spine suite uses) rather than reaching for `any`.
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type Filterable<T> = Term<T> & { eq(column: string, value: unknown): Term<T> };
type ShadowTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown>): Filterable<null>;
  update(patch: Record<string, unknown>): Filterable<null>;
  delete(): Filterable<null>;
};
type ShadowClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): ShadowTable;
};

const TABLE = "hq_ai_executor_shadow_observations";
const RPC = "hq_record_executor_shadow";

const svc = (): ShadowClient => serviceClient() as unknown as ShadowClient;
const anon = (): ShadowClient => anonClient() as unknown as ShadowClient;

/** A valid `planned` observation envelope with a caller-supplied correlation id. */
function plannedArgs(
  correlationId: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    p_outcome: "planned",
    p_source: "autonomous",
    p_correlation_id: correlationId,
    p_task_id: "task-shadow-it",
    p_action_id: "lead:lead_1:memory.write",
    p_tool_label: "memory.write",
    p_idempotency_key: `autonomous·task-shadow-it·memory.write·lead%3Alead_1%3Amemory.write·${correlationId}`,
    p_detail: "",
    ...over,
  };
}

/**
 * Assert an anon read obtained no row — denial being equally valid whether it arrives as a hard
 * privilege error or as an RLS-filtered empty set. A returned row is the only failure.
 */
function expectAnonDenied(res: RpcResult<Record<string, unknown>[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

describeIntegration("Executor-shadow durable store · hq_ai_executor_shadow_observations (R2)", () => {
  it("service_role records a planned observation through the RPC and reads it back; id is monotonic", async () => {
    const correlationId = crypto.randomUUID();

    const first = await svc().rpc<number>(RPC, plannedArgs(correlationId));
    expect(first.error, first.error?.message).toBeNull();
    expect(typeof first.data).toBe("number");
    const id1 = Number(first.data);
    expect(id1).toBeGreaterThan(0);

    const second = await svc().rpc<number>(
      RPC,
      plannedArgs(correlationId, { p_outcome: "refused", p_reason: "invalid_args", p_tool_label: null, p_idempotency_key: null, p_detail: "needs a verdict" }),
    );
    expect(second.error, second.error?.message).toBeNull();
    expect(Number(second.data)).toBeGreaterThan(id1); // the identity sequence is strictly increasing

    const read = await svc()
      .from(TABLE)
      .select("kind, outcome, source, task_id, action_id, tool_label, idempotency_key, reason, detail")
      .eq("correlation_id", correlationId);
    expect(read.error, read.error?.message).toBeNull();
    expect(read.data).toHaveLength(2);

    // Every row is explicitly, unforgeably labelled as a shadow — never an application record.
    for (const row of read.data ?? []) {
      expect(row.kind).toBe("executor_shadow");
      expect(row.source).toBe("autonomous");
    }
    const planned = (read.data ?? []).find((r) => r.outcome === "planned");
    expect(planned?.tool_label).toBe("memory.write");
    expect(planned?.idempotency_key).toContain("autonomous·task-shadow-it·memory.write");
    const refused = (read.data ?? []).find((r) => r.outcome === "refused");
    expect(refused?.reason).toBe("invalid_args");
    expect(refused?.tool_label).toBeNull();
  });

  it("the database REJECTS an `applied` outcome — the table cannot hold an application status", async () => {
    // The Shadow Truthfulness Rule in DDL: `outcome` is CHECKed to the shadow's own vocabulary, so
    // the canonical application statuses are unrepresentable here — the write fails at the database.
    const applied = await svc().rpc<number>(RPC, plannedArgs(crypto.randomUUID(), { p_outcome: "applied" }));
    expect(applied.error, "an `applied` outcome must be rejected by the CHECK constraint").not.toBeNull();

    const failed = await svc().rpc<number>(RPC, plannedArgs(crypto.randomUUID(), { p_outcome: "failed" }));
    expect(failed.error, "a `failed` outcome must be rejected by the CHECK constraint").not.toBeNull();
  });

  it("the `executor_shadow` label is unforgeable — a direct insert of any other kind is rejected", async () => {
    // The RPC hardcodes the kind (no p_kind param); the column CHECK is the SECOND, independent
    // guarantee — even a direct service_role insert cannot write a non-shadow kind.
    const wrongKind = await svc()
      .from(TABLE)
      .insert({
        kind: "applied",
        outcome: "planned",
        source: "autonomous",
        correlation_id: crypto.randomUUID(),
        task_id: "t",
        action_id: "a",
      });
    expect(wrongKind.error, "a non-`executor_shadow` kind must be rejected by the CHECK").not.toBeNull();
  });

  it("anon cannot read the table — RLS:hq denies every JWT client", async () => {
    const correlationId = crypto.randomUUID();
    const rec = await svc().rpc<number>(RPC, plannedArgs(correlationId));
    expect(rec.error, rec.error?.message).toBeNull();

    // service_role (BYPASSRLS) sees the row…
    const asService = await svc().from(TABLE).select("id").eq("correlation_id", correlationId);
    expect(asService.error, asService.error?.message).toBeNull();
    expect(asService.data).toHaveLength(1);

    // …anon does not.
    expectAnonDenied(await anon().from(TABLE).select("id").eq("correlation_id", correlationId));
  });

  it("anon cannot call the SECURITY DEFINER write function — EXECUTE is service_role-only", async () => {
    const rec = await anon().rpc<number>(RPC, plannedArgs(crypto.randomUUID()));
    expect(rec.error, "anon must not be able to record shadow observations").not.toBeNull();
  });

  it("the store is append-only — UPDATE and DELETE are rejected even for service_role", async () => {
    const correlationId = crypto.randomUUID();
    const rec = await svc().rpc<number>(RPC, plannedArgs(correlationId));
    expect(rec.error, rec.error?.message).toBeNull();

    const updated = await svc().from(TABLE).update({ detail: "tampered" }).eq("correlation_id", correlationId);
    expect(updated.error, "UPDATE must be blocked by the append-only guard").not.toBeNull();

    const deleted = await svc().from(TABLE).delete().eq("correlation_id", correlationId);
    expect(deleted.error, "DELETE must be blocked by the append-only guard").not.toBeNull();

    // The row survived both attempts — still exactly one, unchanged.
    const read = await svc().from(TABLE).select("id, detail").eq("correlation_id", correlationId);
    expect(read.data).toHaveLength(1);
    expect(read.data?.[0]?.detail).toBe("");
  });
});

/**
 * The DURABLE store's natural-key idempotency, proven against real Postgres (R2). The RPC itself
 * always inserts (the DB carries no unique constraint — a 0-migration train); idempotency is the
 * store's guard-read over `(correlation_id · task_id · action_id)`, so it can only be proven by
 * driving the REAL store, not the RPC. A re-run of the same autonomous decision — exactly what the
 * Task Engine's whole-task retry produces — must leave exactly ONE row.
 */
describeIntegration("Executor-shadow durable store · natural-key idempotency (R2)", () => {
  const ctx = (correlationId: string, actionId = "lead:lead_1:memory.write"): ShadowObservationContext => ({
    source: "autonomous",
    correlationId,
    taskId: "task-shadow-idem-it",
    actionId,
  });

  it("recording the SAME decision twice leaves exactly one row (first-write-wins)", async () => {
    const correlationId = crypto.randomUUID();
    const store = createDurableShadowObservationStore();
    const record = shadowObservationRecord(ctx(correlationId), {
      outcome: "planned",
      toolLabel: "memory.write",
      idempotencyKey: `autonomous·task-shadow-idem-it·memory.write·lead%3Alead_1%3Amemory.write·${correlationId}`,
    });

    const first = await store.record(record);
    const second = await store.record(record); // the retry
    expect(first.ok, first.ok ? "" : first.error).toBe(true);
    expect(second.ok, second.ok ? "" : second.error).toBe(true);
    // the retry returned the FIRST row's id — a no-op success, not a new insert
    if (first.ok && second.ok) expect(second.id).toBe(first.id);

    const read = await svc().from(TABLE).select("id").eq("correlation_id", correlationId);
    expect(read.error, read.error?.message).toBeNull();
    expect(read.data, "a re-run must not duplicate the shadow row").toHaveLength(1);
  });

  it("a DIFFERENT action under the same run is a distinct key → a distinct row", async () => {
    const correlationId = crypto.randomUUID();
    const store = createDurableShadowObservationStore();
    await store.record(
      shadowObservationRecord(ctx(correlationId, "lead:lead_1:memory.write"), {
        outcome: "planned",
        toolLabel: "memory.write",
        idempotencyKey: `autonomous·task-shadow-idem-it·memory.write·lead%3Alead_1%3Amemory.write·${correlationId}`,
      }),
    );
    await store.record(
      shadowObservationRecord(ctx(correlationId, "lead:lead_2:memory.write"), {
        outcome: "planned",
        toolLabel: "memory.write",
        idempotencyKey: `autonomous·task-shadow-idem-it·memory.write·lead%3Alead_2%3Amemory.write·${correlationId}`,
      }),
    );

    const read = await svc().from(TABLE).select("action_id").eq("correlation_id", correlationId);
    expect(read.error, read.error?.message).toBeNull();
    expect(read.data).toHaveLength(2);
  });
});
