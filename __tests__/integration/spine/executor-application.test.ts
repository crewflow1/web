import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * Executor durable application store — real-Postgres proof of Directive #016 R3 (Module: Live
 * Executor Rollout).
 *
 * The unit tier proves the pure record builders + the service's envelope mapping against an
 * in-memory / mocked RPC; this tier proves the BEHAVIOUR the mocks can't — that the migration's
 * storage, RLS, the applied-terminal guard, the privilege model AND the two §2 rules the table
 * enforces in DDL actually hold in a live database ("mocks prove intent; real infrastructure proves
 * behaviour"):
 *
 *   • THE APPLICATION ATOMICITY RULE — a failure can never wear an applied shape. The discriminated
 *     `hq_ai_applications_shape` CHECK is proven by the database rejecting an applied row that
 *     carries an error, and a failed row that carries a result or omits error/escalated.
 *   • THE SHADOW ISOLATION RULE — the application store draws `status` from a vocabulary DISJOINT
 *     from the shadow store's (`applied`/`failed`, never `planned`/`refused`/`error`). Proven by the
 *     database rejecting a shadow outcome as a status — the two stores can never be query-compatible.
 *   • THE EXECUTOR IDEMPOTENCY RULE — one row per key, an applied row is TERMINAL and immutable, and
 *     no row is ever deleted. Proven by the failed→failed→applied progression, the guard rejecting a
 *     re-put onto an applied key, and the DELETE guard.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED loudly
 * in CI if the database is missing. An applied row is terminal and no row is ever deleted, so these
 * tests intentionally leave their rows behind — harmless in the ephemeral CI database, and proving
 * exactly that (the no-delete guard) is one of the tests below. Every test uses a UNIQUE idempotency
 * key so the shared run never sees cross-test interference on the primary key.
 */

// hq_ai_applications / hq_get_application / hq_put_application are service-role-only internals and
// are NOT in the generated Database types. Cast to the minimal surface this suite exercises (the
// same `as unknown as` convention the spine + shadow suites use) rather than reaching for `any`.
type RpcResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<RpcResult<T>>;
type Filterable<T> = Term<T> & { eq(column: string, value: unknown): Term<T> };
type Row = Record<string, unknown>;
type AppTable = {
  select(columns?: string): Filterable<Row[]>;
  insert(row: Row): Filterable<null>;
  delete(): Filterable<null>;
};
type AppClient = {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Term<T>;
  from(table: string): AppTable;
};

const TABLE = "hq_ai_applications";
const PUT = "hq_put_application";
const GET = "hq_get_application";

const svc = (): AppClient => serviceClient() as unknown as AppClient;
const anon = (): AppClient => anonClient() as unknown as AppClient;

/** The `autonomous` execution identity an application key derives from (carried whole in the row). */
function identity(correlationId: string): Record<string, unknown> {
  return {
    source: "autonomous",
    correlationId,
    taskId: "task-app-it",
    toolLabel: "memory.write",
    actionId: "lead:lead_1:memory.write",
  };
}

/** A valid `applied` put envelope — carries a result and NO failure fields (the shape CHECK). */
function appliedArgs(
  key: string,
  correlationId: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    p_key: key,
    p_status: "applied",
    p_identity: identity(correlationId),
    p_label: "memory.write",
    p_attempts: 1,
    p_result: { ok: true },
    ...over,
  };
}

/** A valid `failed` put envelope — carries error + escalated and NO result (the shape CHECK). */
function failedArgs(
  key: string,
  correlationId: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    p_key: key,
    p_status: "failed",
    p_identity: identity(correlationId),
    p_label: "memory.write",
    p_attempts: 1,
    p_error: "tool implementation exploded",
    p_escalated: false,
    ...over,
  };
}

const uniqueKey = (): string => `app-it-${crypto.randomUUID()}`;

/**
 * Assert an anon read obtained no row — denial being equally valid whether it arrives as a hard
 * privilege error or as an RLS-filtered empty set. A returned row is the only failure.
 */
function expectAnonDenied(res: RpcResult<Row[]>): void {
  if (res.error) return;
  expect(res.data ?? []).toHaveLength(0);
}

describeIntegration("Executor durable application store · hq_ai_applications (R3)", () => {
  it("service_role progresses a record failed→failed→applied through the RPCs; applied is then terminal", async () => {
    const key = uniqueKey();
    const corr = crypto.randomUUID();

    // First attempt FAILS — recorded as a granular failure, the action left unapplied.
    const put1 = await svc().rpc<string>(PUT, failedArgs(key, corr));
    expect(put1.error, put1.error?.message).toBeNull();
    expect(put1.data).toBe(key); // the RPC returns the key on success

    const get1 = await svc().rpc<Row>(GET, { p_key: key });
    expect(get1.error, get1.error?.message).toBeNull();
    expect(get1.data?.status).toBe("failed");
    expect(get1.data?.error).toBe("tool implementation exploded");
    expect(get1.data?.escalated).toBe(false);
    expect(get1.data?.attempts).toBe(1);
    expect(get1.data?.result).toBeNull();

    // Second attempt ALSO fails — a failed row may be progressed (a bounded re-attempt).
    const put2 = await svc().rpc<string>(PUT, failedArgs(key, corr, { p_attempts: 2 }));
    expect(put2.error, put2.error?.message).toBeNull();
    const get2 = await svc().rpc<Row>(GET, { p_key: key });
    expect(get2.data?.status).toBe("failed");
    expect(get2.data?.attempts).toBe(2);

    // Third attempt SUCCEEDS — the failed→applied progression.
    const put3 = await svc().rpc<string>(PUT, appliedArgs(key, corr, { p_attempts: 3 }));
    expect(put3.error, put3.error?.message).toBeNull();
    const get3 = await svc().rpc<Row>(GET, { p_key: key });
    expect(get3.data?.status).toBe("applied");
    expect(get3.data?.result).toEqual({ ok: true });
    expect(get3.data?.attempts).toBe(3);
    expect(get3.data?.error).toBeNull();
    expect(get3.data?.escalated).toBeNull();

    // Applied is TERMINAL + immutable — a further put onto the key is rejected by the guard.
    const put4 = await svc().rpc<string>(PUT, appliedArgs(key, corr, { p_attempts: 4 }));
    expect(put4.error, "an applied row is terminal; a re-put must be rejected by the guard").not.toBeNull();

    // …and the ground truth is unchanged — the recorded apply can never be rewritten.
    const get4 = await svc().rpc<Row>(GET, { p_key: key });
    expect(get4.data?.status).toBe("applied");
    expect(get4.data?.attempts).toBe(3);
  });

  it("hq_get_application returns null for an unknown key — the no-op-success lookup", async () => {
    const res = await svc().rpc<Row>(GET, { p_key: `absent-${crypto.randomUUID()}` });
    expect(res.error, res.error?.message).toBeNull();
    expect(res.data).toBeNull();
  });

  it("the shape CHECK rejects a malformed row — a failure can never wear an applied shape (Atomicity Rule)", async () => {
    const corr = crypto.randomUUID();

    // applied WITH an error — forbidden: an applied row carries no failure fields.
    const appliedWithError = await svc().from(TABLE).insert({
      idempotency_key: uniqueKey(),
      status: "applied",
      identity: identity(corr),
      label: "memory.write",
      attempts: 1,
      result: { ok: true },
      error: "should not be here",
    });
    expect(appliedWithError.error, "an applied row carrying an error must be rejected").not.toBeNull();

    // failed WITHOUT error/escalated — forbidden: a failed row must carry both.
    const failedNoError = await svc().from(TABLE).insert({
      idempotency_key: uniqueKey(),
      status: "failed",
      identity: identity(corr),
      label: "memory.write",
      attempts: 1,
    });
    expect(failedNoError.error, "a failed row must carry error + escalated").not.toBeNull();

    // failed WITH a result — forbidden: a failed row carries no applied result.
    const failedWithResult = await svc().from(TABLE).insert({
      idempotency_key: uniqueKey(),
      status: "failed",
      identity: identity(corr),
      label: "memory.write",
      attempts: 1,
      error: "x",
      escalated: false,
      result: { ok: true },
    });
    expect(failedWithResult.error, "a failed row must not carry a result").not.toBeNull();
  });

  it("the status CHECK rejects a shadow outcome — the vocabularies are DISJOINT (Shadow Isolation Rule)", async () => {
    // The application store's status is `applied`/`failed` ONLY. A shadow outcome, or an approval
    // state, is unrepresentable here — so a shadow row and an applied row can never be query-compatible.
    for (const bogus of ["planned", "refused", "error", "approved"]) {
      const res = await svc().from(TABLE).insert({
        idempotency_key: uniqueKey(),
        status: bogus,
        identity: identity(crypto.randomUUID()),
        label: "memory.write",
        attempts: 1,
      });
      expect(res.error, `status "${bogus}" must be rejected — it is not an application status`).not.toBeNull();
    }
  });

  it("the identity source CHECK rejects an unknown apply path", async () => {
    const res = await svc().from(TABLE).insert({
      idempotency_key: uniqueKey(),
      status: "applied",
      identity: { source: "smuggled", correlationId: crypto.randomUUID() },
      label: "memory.write",
      attempts: 1,
      result: { ok: true },
    });
    expect(res.error, "identity.source must be one of the two apply paths").not.toBeNull();
  });

  it("the ground truth is never deleted — DELETE is rejected even for service_role", async () => {
    const key = uniqueKey();
    const corr = crypto.randomUUID();
    const put = await svc().rpc<string>(PUT, appliedArgs(key, corr));
    expect(put.error, put.error?.message).toBeNull();

    const del = await svc().from(TABLE).delete().eq("idempotency_key", key);
    expect(del.error, "DELETE must be blocked by the terminal guard").not.toBeNull();

    // The row survived — still exactly one, still applied.
    const read = await svc().from(TABLE).select("idempotency_key, status").eq("idempotency_key", key);
    expect(read.data).toHaveLength(1);
    expect(read.data?.[0]?.status).toBe("applied");
  });

  it("anon cannot read the table — RLS:hq denies every JWT client", async () => {
    const key = uniqueKey();
    const corr = crypto.randomUUID();
    const put = await svc().rpc<string>(PUT, failedArgs(key, corr));
    expect(put.error, put.error?.message).toBeNull();

    // service_role (BYPASSRLS) sees the row…
    const asService = await svc().from(TABLE).select("idempotency_key").eq("idempotency_key", key);
    expect(asService.error, asService.error?.message).toBeNull();
    expect(asService.data).toHaveLength(1);

    // …anon does not.
    expectAnonDenied(await anon().from(TABLE).select("idempotency_key").eq("idempotency_key", key));
  });

  it("anon cannot call the SECURITY DEFINER functions — EXECUTE is service_role-only", async () => {
    const put = await anon().rpc<string>(PUT, failedArgs(uniqueKey(), crypto.randomUUID()));
    expect(put.error, "anon must not be able to put an application record").not.toBeNull();

    const get = await anon().rpc<Row>(GET, { p_key: uniqueKey() });
    expect(get.error, "anon must not be able to read an application record").not.toBeNull();
  });
});
