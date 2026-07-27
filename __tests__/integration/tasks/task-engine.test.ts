import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * The Generic Task Engine — real-Postgres proof (CEO Directive #012 / D-02, PR-A).
 *
 * The security tier (hermetic) pins the trust boundary in the migration's SOURCE —
 * RLS:hq, SECURITY DEFINER + search_path='', service-role-only EXECUTE, no dynamic
 * SQL, generic naming. THIS tier proves the BEHAVIOUR neither a mock nor a source
 * check can: that against a LIVE database with the real migration applied —
 *
 *   • the claim is ATOMIC — concurrent workers each take a DISTINCT runnable row
 *     (FOR UPDATE SKIP LOCKED), closing the read-then-write race the old TypeScript
 *     conditional UPDATE left open;
 *   • the queue dequeues in priority order (urgent → low);
 *   • the lease/heartbeat/reaper recover a dead worker by declared liveness, not a
 *     wall clock — a lost lease aborts the worker, an expired lease is re-queued;
 *   • retry applies exponential backoff (scheduled into the future), then fails
 *     terminally when retries are exhausted;
 *   • dedupe is idempotent over a live key;
 *   • the BEFORE guard makes born-non-pending, terminal mutation, and rewriting what
 *     a task IS structurally impossible — even for the service-role client that
 *     BYPASSES RLS (the boundary cannot be bypassed, architecture not convention);
 *   • RLS:hq denies every JWT client, and the entry points reject anon EXECUTE.
 *
 * Runs only against a live DB (describeIntegration): skips locally with no DB, fails
 * loudly in CI if the DB is missing. Rows are tagged with a per-run task_type token
 * and deleted on teardown (DELETE is unguarded; only INSERT/UPDATE are).
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Thenable<T> = PromiseLike<Res<T>>;
type Row = Record<string, unknown>;

interface Sel extends Thenable<Row[]> {
  eq(column: string, value: unknown): Sel;
  in(column: string, values: ReadonlyArray<unknown>): Sel;
  order(column: string, opts?: { ascending?: boolean }): Sel;
  limit(n: number): Sel;
  single(): Thenable<Row>;
  maybeSingle(): Thenable<Row>;
}
interface InsertChain extends Thenable<Row[]> {
  select(columns?: string): Sel;
}
interface UpdChain extends Thenable<Row[]> {
  eq(column: string, value: unknown): UpdChain;
  select(columns?: string): Sel;
}
interface DelChain extends PromiseLike<{ error: { message: string } | null }> {
  eq(column: string, value: unknown): DelChain;
  in(column: string, values: ReadonlyArray<unknown>): DelChain;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): InsertChain;
  update(values: Row): UpdChain;
  delete(): DelChain;
}
interface Rpc {
  rpc(fn: string, args: Row): Thenable<unknown>;
}
interface Db {
  from(table: string): Table;
}
const db = (client: unknown): Db => client as unknown as Db;
const rpc = (client: unknown): Rpc => client as unknown as Rpc;

// The row-returning entry points (create/claim/complete/fail) speak a jsonb envelope
// — {ok:true, task:{…}} or {ok:false, reason:'empty'|'lease_lost'} — exactly like the
// reference engine's (Shared Memory) claim/complete/fail, so a "no row" outcome is
// explicit and never a composite of all-null columns over PostgREST. taskOf() unwraps
// it to the row, or null when ok is false.
type TaskEnvelope = { ok: boolean; reason?: string; task?: Row };
function taskOf(env: unknown): Row | null {
  const e = env as TaskEnvelope | null;
  return e && e.ok ? ((e.task as Row) ?? null) : null;
}

function alpha(n: number): string {
  const a = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

// Every task this suite creates is tagged with a type prefixed by this token, so a
// claim only ever sees THIS run's tasks and teardown deletes exactly them.
const TOKEN = `it_task_${alpha(8)}`;
function typeFor(tag: string): string {
  return `${TOKEN}_${tag}`;
}

const TASK_COLS =
  "id, task_type, status, priority, priority_rank, retry_count, max_retries, " +
  "lease_owner, lease_expires_at, heartbeat_at, scheduled_at, claimed_at, started_at, " +
  "finished_at, payload, result, error_message, correlation_id, dedupe_key";

async function createTask(taskType: string, over: Row = {}): Promise<Row> {
  const res = await rpc(serviceClient()).rpc("hq_ai_task_create", {
    p_task_type: taskType,
    p_payload: { tag: taskType },
    ...over,
  });
  const r = res as Res<unknown>;
  expect(r.error, r.error?.message).toBeNull();
  const task = taskOf(r.data);
  expect(task, "create returned no task").toBeTruthy();
  return task as Row;
}

async function claim(taskType: string, owner: string, leaseSeconds = 300): Promise<Row | null> {
  const res = (await rpc(serviceClient()).rpc("hq_ai_task_claim", {
    p_task_type: taskType,
    p_lease_owner: owner,
    p_lease_seconds: leaseSeconds,
  })) as Res<unknown>;
  expect(res.error, res.error?.message).toBeNull();
  return taskOf(res.data);
}

async function readRow(id: string): Promise<Row | null> {
  const res = await db(serviceClient()).from("hq_ai_tasks").select(TASK_COLS).eq("id", id).maybeSingle();
  expect(res.error, res.error?.message).toBeNull();
  return res.data;
}

describeIntegration("The Generic Task Engine · DB-enforced lifecycle + atomic claim (Directive #012 / D-02)", () => {
  beforeAll(async () => {
    // Smoke: the migration is applied (the table exists for service_role).
    const probe = await db(serviceClient()).from("hq_ai_tasks").select("id").limit(1);
    expect(probe.error, probe.error?.message).toBeNull();
  });

  afterAll(async () => {
    // DELETE is unguarded — purge exactly this run's tasks (any task_type we made).
    const svc = serviceClient();
    const mine = await db(svc).from("hq_ai_tasks").select("id, task_type");
    const ids = (mine.data ?? [])
      .filter((r) => String(r.task_type).startsWith(TOKEN))
      .map((r) => String(r.id));
    if (ids.length) await db(svc).from("hq_ai_tasks").delete().in("id", ids);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Happy path: create → claim → checkpoint → complete.
  // ─────────────────────────────────────────────────────────────────────────
  it("walks create → claim → checkpoint → complete, stamping the lease and clearing it", async () => {
    const t = typeFor("happy");
    const born = await createTask(t);
    expect(born.status).toBe("pending");
    expect(born.lease_owner).toBeNull();
    expect(born.correlation_id).toBeTruthy();
    const id = String(born.id);

    const claimed = await claim(t, "worker-1");
    expect(claimed, "a pending task must be claimable").toBeTruthy();
    expect(String(claimed?.id)).toBe(id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.lease_owner).toBe("worker-1");
    expect(claimed?.lease_expires_at).toBeTruthy();
    expect(claimed?.started_at).toBeTruthy();

    const cp = (await rpc(serviceClient()).rpc("hq_ai_task_checkpoint", {
      p_task_id: id,
      p_lease_owner: "worker-1",
      p_result: { progress: 0.5 },
    })) as Res<boolean>;
    expect(cp.error, cp.error?.message).toBeNull();
    expect(cp.data).toBe(true);
    expect((await readRow(id))?.result).toEqual({ progress: 0.5 });

    const done = (await rpc(serviceClient()).rpc("hq_ai_task_complete", {
      p_task_id: id,
      p_lease_owner: "worker-1",
      p_result: { progress: 1, ok: true },
    })) as Res<unknown>;
    expect(done.error, done.error?.message).toBeNull();
    const dt = taskOf(done.data);
    expect(dt?.status).toBe("completed");
    expect(dt?.finished_at).toBeTruthy();
    expect(dt?.lease_owner).toBeNull();
    expect(dt?.result).toEqual({ progress: 1, ok: true });
  });

  it("returns NULL when the queue is empty (nothing to claim)", async () => {
    const claimed = await claim(typeFor("empty"), "worker-x");
    expect(claimed).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // THE load-bearing proof: the claim is atomic under concurrency.
  // ─────────────────────────────────────────────────────────────────────────
  it("hands each concurrent worker a DISTINCT task — FOR UPDATE SKIP LOCKED, no double-claim", async () => {
    const t = typeFor("race");
    const N = 5;
    for (let i = 0; i < N; i++) await createTask(t);

    // 8 workers race for 5 tasks: exactly 5 distinct claims, 3 empty — never a
    // duplicate (which a conditional UPDATE could produce under interleaving).
    const owners = Array.from({ length: 8 }, (_, i) => `racer-${i}`);
    const results = await Promise.all(owners.map((o) => claim(t, o)));

    const claimedIds = results.filter((r): r is Row => r != null).map((r) => String(r.id));
    expect(claimedIds).toHaveLength(N);
    expect(new Set(claimedIds).size).toBe(N); // all DISTINCT — the atomicity guarantee
  });

  it("dequeues in priority order — urgent before high before normal before low", async () => {
    const t = typeFor("priority");
    // Insert out of priority order; the queue index must still order them.
    await createTask(t, { p_priority: "low" });
    await createTask(t, { p_priority: "urgent" });
    await createTask(t, { p_priority: "normal" });
    await createTask(t, { p_priority: "high" });

    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await claim(t, `prio-${i}`);
      order.push(String(c?.priority));
    }
    expect(order).toEqual(["urgent", "high", "normal", "low"]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Lease / heartbeat / reaper — crash recovery by declared liveness.
  // ─────────────────────────────────────────────────────────────────────────
  it("heartbeat extends the lease for the holder and is refused to anyone else", async () => {
    const t = typeFor("hb");
    await createTask(t);
    const claimed = await claim(t, "hb-owner", 300);
    const id = String(claimed?.id);
    const firstExpiry = new Date(String(claimed?.lease_expires_at)).getTime();

    const ok = (await rpc(serviceClient()).rpc("hq_ai_task_heartbeat", {
      p_task_id: id,
      p_lease_owner: "hb-owner",
      p_lease_seconds: 600,
    })) as Res<boolean>;
    expect(ok.error, ok.error?.message).toBeNull();
    expect(ok.data).toBe(true);
    const extended = new Date(String((await readRow(id))?.lease_expires_at)).getTime();
    expect(extended).toBeGreaterThan(firstExpiry);

    // A stranger cannot heartbeat (lost/stolen lease → the worker must abort).
    const stranger = (await rpc(serviceClient()).rpc("hq_ai_task_heartbeat", {
      p_task_id: id,
      p_lease_owner: "not-the-owner",
      p_lease_seconds: 600,
    })) as Res<boolean>;
    expect(stranger.data).toBe(false);
  });

  it("the reaper re-queues a task whose lease has expired (retries remain)", async () => {
    const t = typeFor("reap");
    await createTask(t);
    const claimed = await claim(t, "doomed-worker", 300);
    const id = String(claimed?.id);
    expect(claimed?.status).toBe("running");

    // Force the lease into the past (running → running; the guard allows it). This
    // simulates a worker that died without heartbeating.
    const expire = await db(serviceClient())
      .from("hq_ai_tasks")
      .update({ lease_expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", id);
    expect(expire.error, expire.error?.message).toBeNull();

    const reaped = (await rpc(serviceClient()).rpc("hq_ai_task_reap", {
      p_task_type: t,
      p_limit: 10,
    })) as Res<number>;
    expect(reaped.error, reaped.error?.message).toBeNull();
    expect(Number(reaped.data)).toBeGreaterThanOrEqual(1);

    const after = await readRow(id);
    expect(after?.status).toBe("pending"); // re-queued, claimable again
    expect(Number(after?.retry_count)).toBe(1);
    expect(after?.lease_owner).toBeNull();
    expect(after?.scheduled_at).toBeTruthy(); // backoff deferred it
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Retry & backoff, then terminal failure.
  // ─────────────────────────────────────────────────────────────────────────
  it("fail(retryable) re-queues with backoff; exhausting retries fails terminally", async () => {
    const t = typeFor("retry");
    await createTask(t, { p_max_retries: 1 });

    // First failure: retryable, retries remain → back to pending, retry_count 1,
    // scheduled into the future (≈30s backoff).
    let c = await claim(t, "w");
    const id = String(c?.id);
    const fail1 = (await rpc(serviceClient()).rpc("hq_ai_task_fail", {
      p_task_id: id,
      p_lease_owner: "w",
      p_error: "transient upstream error",
      p_retryable: true,
    })) as Res<unknown>;
    expect(fail1.error, fail1.error?.message).toBeNull();
    const f1 = taskOf(fail1.data);
    expect(f1?.status).toBe("pending");
    expect(Number(f1?.retry_count)).toBe(1);
    expect(new Date(String(f1?.scheduled_at)).getTime()).toBeGreaterThan(Date.now());

    // Clear the backoff so we can re-claim immediately, then fail again: retries are
    // now exhausted (max_retries=1) → terminal failed.
    await db(serviceClient()).from("hq_ai_tasks").update({ scheduled_at: null }).eq("id", id);
    c = await claim(t, "w2");
    expect(String(c?.id)).toBe(id);
    const fail2 = (await rpc(serviceClient()).rpc("hq_ai_task_fail", {
      p_task_id: id,
      p_lease_owner: "w2",
      p_error: "still failing",
      p_retryable: true,
    })) as Res<unknown>;
    expect(fail2.error, fail2.error?.message).toBeNull();
    const f2 = taskOf(fail2.data);
    expect(f2?.status).toBe("failed");
    expect(f2?.finished_at).toBeTruthy();
  });

  it("is idempotent over a live dedupe_key — the same key returns the same task", async () => {
    const t = typeFor("dedupe");
    const key = `k_${alpha(10)}`;
    const a = await createTask(t, { p_dedupe_key: key });
    const b = await createTask(t, { p_dedupe_key: key });
    expect(String(b.id)).toBe(String(a.id)); // not duplicated

    const rows = await db(serviceClient())
      .from("hq_ai_tasks")
      .select("id")
      .eq("dedupe_key", key);
    expect((rows.data ?? []).length).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The guard — structural guarantees, each proven illegal at the DB.
  // ─────────────────────────────────────────────────────────────────────────
  it("enforces born-pending — a task cannot be inserted into a non-pending state", async () => {
    for (const status of ["running", "completed", "failed", "cancelled"]) {
      const res = await db(serviceClient())
        .from("hq_ai_tasks")
        .insert({ task_type: typeFor("born"), status })
        .select("id");
      expect(res.error, `insert into status ${status} must be rejected`).not.toBeNull();
    }
  });

  it("keeps the task definition write-once and terminal rows immutable", async () => {
    const t = typeFor("immutable");
    const born = await createTask(t, { p_payload: { original: true } });
    const id = String(born.id);

    // Write-once: task_type / payload cannot be rewritten.
    const tamperType = await db(serviceClient())
      .from("hq_ai_tasks")
      .update({ task_type: "rewritten" })
      .eq("id", id);
    expect(tamperType.error, "task_type must be write-once").not.toBeNull();
    const tamperPayload = await db(serviceClient())
      .from("hq_ai_tasks")
      .update({ payload: { original: false } })
      .eq("id", id);
    expect(tamperPayload.error, "payload must be write-once").not.toBeNull();

    // Cancel it (pending → cancelled, terminal), then prove it is frozen.
    const cancel = await db(serviceClient())
      .from("hq_ai_tasks")
      .update({ status: "cancelled" })
      .eq("id", id)
      .select("status")
      .single();
    expect(cancel.error, cancel.error?.message).toBeNull();
    expect((cancel.data as Row).status).toBe("cancelled");

    const tamperTerminal = await db(serviceClient())
      .from("hq_ai_tasks")
      .update({ error_message: "poke" })
      .eq("id", id);
    expect(tamperTerminal.error, "a terminal task must be immutable").not.toBeNull();
  });

  it("rejects an illegal transition (pending → completed without running)", async () => {
    const t = typeFor("illegal");
    const born = await createTask(t);
    const jump = await db(serviceClient())
      .from("hq_ai_tasks")
      .update({ status: "completed" })
      .eq("id", String(born.id));
    expect(jump.error, "pending → completed must be rejected").not.toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // RLS:hq + service-role-only EXECUTE — the engine is HQ infrastructure.
  // ─────────────────────────────────────────────────────────────────────────
  it("denies anon read/write (RLS:hq) and refuses anon EXECUTE on the entry points", async () => {
    const t = typeFor("rls");
    const born = await createTask(t);
    const id = String(born.id);

    // service_role sees it…
    const asService = await db(serviceClient()).from("hq_ai_tasks").select("id").eq("id", id);
    expect(asService.error, asService.error?.message).toBeNull();
    expect(asService.data).toHaveLength(1);

    // …anon does not (RLS-filtered empty set, or a hard error — either is a denial).
    const anonRead = await db(anonClient()).from("hq_ai_tasks").select("id").eq("id", id);
    if (!anonRead.error) expect(anonRead.data ?? []).toHaveLength(0);

    // An anon insert is rejected outright.
    const anonInsert = await db(anonClient())
      .from("hq_ai_tasks")
      .insert({ task_type: typeFor("rls-anon"), status: "pending" })
      .select("id");
    expect(anonInsert.error, "anon must not insert a task").not.toBeNull();

    // EXECUTE on the entry points is revoked from anon — the rpc must fail.
    const anonClaim = (await rpc(anonClient()).rpc("hq_ai_task_claim", {
      p_task_type: t,
      p_lease_owner: "anon-attacker",
    })) as Res<unknown>;
    expect(anonClaim.error, "anon must not EXECUTE hq_ai_task_claim").not.toBeNull();
  });
});
