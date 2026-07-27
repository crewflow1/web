import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * The Generic Task Engine — spine emission, real-Postgres proof (Directive #012 / D-02, PR-B).
 *
 * PR-A proved the queue BEHAVES (claim atomicity, lease, reaper, guard). This tier
 * proves the new thing PR-B adds: every WIRED transition writes ONE canonical
 * `task.*` Event Spine row, IN THE SAME TRANSACTION as the status change, with the
 * HONEST actor and reason — the precision the function-emission choice (ADR 0005)
 * buys that an AFTER trigger could not. Against a LIVE database with the real
 * migration applied, this suite pins —
 *
 *   • each transition emits exactly its verb at the right severity: create→task.created
 *     (info), claim→task.claimed (info), complete→task.completed (success),
 *     fail→task.retried|task.failed (warn), reap→task.retried|task.failed (warn);
 *   • the two ROW-AMBIGUOUS transitions are told apart by actor + payload.reason — a
 *     worker-reported retry (actor: the employee/worker; reason: worker_error) vs a
 *     reaper-recovered dead lease (actor: SYSTEM; reason: lease_expired, carrying the
 *     dead_lease_owner) — the distinction the spine must not blur;
 *   • an ASSIGNED task is attributed to its ai_employee; an unassigned one to system;
 *   • heartbeat and checkpoint emit NOTHING (liveness / internal resumption, not facts);
 *   • a dedupe hit mints NO second task.created (no new work was enqueued);
 *   • a whole lifecycle threads into ONE correlation_id as an ordered verb sequence.
 *
 * Runs only against a live DB (describeIntegration): skips locally with no DB, fails
 * loudly in CI if the DB is missing. hq_events is append-only, so the spine rows are
 * left behind (harmless in the ephemeral CI database); the hq_ai_tasks rows are tagged
 * with a per-run task_type token and deleted on teardown.
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

// The row-returning entry points speak a jsonb envelope — {ok:true, task:{…}} or
// {ok:false, reason:'empty'|'lease_lost'}. taskOf() unwraps it to the row, or null.
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
const TOKEN = `it_spine_${alpha(8)}`;
function typeFor(tag: string): string {
  return `${TOKEN}_${tag}`;
}

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

/** Force a claimed task's lease into the past, simulating a worker that died. */
async function expireLease(id: string): Promise<void> {
  const res = await db(serviceClient())
    .from("hq_ai_tasks")
    .update({ lease_expires_at: new Date(Date.now() - 60_000).toISOString() })
    .eq("id", id);
  expect(res.error, res.error?.message).toBeNull();
}

const EVENT_COLS = "id, verb, actor_type, actor_id, severity, payload";

/** All spine events for one correlation, in emission order (id asc). */
async function eventsOrdered(correlationId: string): Promise<Row[]> {
  const res = await db(serviceClient())
    .from("hq_events")
    .select(EVENT_COLS)
    .eq("correlation_id", correlationId)
    .order("id", { ascending: true });
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

/** Spine events for one correlation keyed by verb (one per verb in single-pass traces). */
async function eventsByVerb(correlationId: string): Promise<Record<string, Row>> {
  const out: Record<string, Row> = {};
  for (const row of await eventsOrdered(correlationId)) out[String(row.verb)] = row;
  return out;
}

function requireEvent(ev: Record<string, Row>, verb: string): Row {
  const row = ev[verb];
  expect(row, `missing spine event ${verb}`).toBeTruthy();
  if (!row) throw new Error(`missing spine event ${verb}`);
  return row;
}

// Seeded in beforeAll: a real ai_employee, to prove the assigned-task actor mapping.
let EMPLOYEE_ID = "";

describeIntegration("The Generic Task Engine · spine emission (Directive #012 / D-02, PR-B)", () => {
  beforeAll(async () => {
    // Smoke: the migration is applied (the table exists for service_role).
    const probe = await db(serviceClient()).from("hq_ai_tasks").select("id").limit(1);
    expect(probe.error, probe.error?.message).toBeNull();

    // Any registered AI employee satisfies the assigned_employee_id FK; we use it to
    // prove an assigned task is attributed to its employee, an unassigned one to system.
    const employee = await db(serviceClient()).from("ai_employees").select("id").limit(1).single();
    expect(employee.error, employee.error?.message).toBeNull();
    EMPLOYEE_ID = String((employee.data as { id?: string })?.id ?? "");
    if (!EMPLOYEE_ID) throw new Error("no ai_employees row to act as the assignee — is the roster migration applied?");
  });

  afterAll(async () => {
    // hq_events is append-only and left behind; purge exactly this run's tasks.
    const svc = serviceClient();
    const mine = await db(svc).from("hq_ai_tasks").select("id, task_type");
    const ids = (mine.data ?? [])
      .filter((r) => String(r.task_type).startsWith(TOKEN))
      .map((r) => String(r.id));
    if (ids.length) await db(svc).from("hq_ai_tasks").delete().in("id", ids);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // create — task.created, only on a genuine insert.
  // ─────────────────────────────────────────────────────────────────────────
  it("create emits ONE task.created (info), carrying the task's identity in the payload", async () => {
    const t = typeFor("created");
    const born = await createTask(t);
    const correlation = String(born.correlation_id);

    const ev = await eventsByVerb(correlation);
    expect(Object.keys(ev)).toEqual(["task.created"]);
    const created = requireEvent(ev, "task.created");
    expect(created.actor_type).toBe("system"); // unassigned → system
    expect(created.actor_id).toBe("system");
    expect(created.severity).toBe("info");
    const p = created.payload as Row;
    expect(p.task_id).toBe(born.id);
    expect(p.task_type).toBe(t);
    expect(p.status).toBe("pending");
  });

  it("a dedupe HIT mints NO second task.created — the live task is returned, no new work enqueued", async () => {
    const t = typeFor("dedupe");
    const key = `k_${alpha(10)}`;
    const a = await createTask(t, { p_dedupe_key: key });
    const b = await createTask(t, { p_dedupe_key: key });
    expect(String(b.id)).toBe(String(a.id)); // same row returned

    // Both creates share the original task's correlation_id; only ONE event exists.
    const events = await eventsOrdered(String(a.correlation_id));
    const created = events.filter((e) => e.verb === "task.created");
    expect(created).toHaveLength(1);
  });

  it("an ASSIGNED task is attributed to its ai_employee on create AND claim (actor mapping v1)", async () => {
    const t = typeFor("assigned");
    const born = await createTask(t, { p_assigned_employee_id: EMPLOYEE_ID });
    const correlation = String(born.correlation_id);

    const claimed = await claim(t, "worker-assigned");
    expect(String(claimed?.id)).toBe(String(born.id));

    const ev = await eventsByVerb(correlation);
    const created = requireEvent(ev, "task.created");
    expect(created.actor_type).toBe("ai_employee");
    expect(created.actor_id).toBe(EMPLOYEE_ID);

    const claimedEv = requireEvent(ev, "task.claimed");
    expect(claimedEv.actor_type).toBe("ai_employee");
    expect(claimedEv.actor_id).toBe(EMPLOYEE_ID); // the employee, not the lease token
    // …but the worker token is still recorded in the payload for forensics.
    expect((claimedEv.payload as Row).lease_owner).toBe("worker-assigned");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // claim → complete — the success path.
  // ─────────────────────────────────────────────────────────────────────────
  it("claim emits task.claimed (info) and complete emits task.completed (success)", async () => {
    const t = typeFor("complete");
    const born = await createTask(t);
    const correlation = String(born.correlation_id);
    const id = String(born.id);

    const claimed = await claim(t, "worker-c");
    expect(claimed?.status).toBe("running");

    const done = (await rpc(serviceClient()).rpc("hq_ai_task_complete", {
      p_task_id: id,
      p_lease_owner: "worker-c",
      p_result: { ok: true },
    })) as Res<unknown>;
    expect(done.error, done.error?.message).toBeNull();
    expect(taskOf(done.data)?.status).toBe("completed");

    const ev = await eventsByVerb(correlation);
    expect(Object.keys(ev).sort()).toEqual(["task.claimed", "task.completed", "task.created"].sort());

    const claimedEv = requireEvent(ev, "task.claimed");
    expect(claimedEv.actor_type).toBe("system"); // unassigned
    expect(claimedEv.actor_id).toBe("worker-c"); // the lease token stands in for identity
    expect(claimedEv.severity).toBe("info");

    const completedEv = requireEvent(ev, "task.completed");
    expect(completedEv.severity).toBe("success");
    expect((completedEv.payload as Row).status).toBe("completed");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // fail — worker-reported retry vs terminal, both reason=worker_error.
  // ─────────────────────────────────────────────────────────────────────────
  it("fail(retryable) emits task.retried (warn, reason=worker_error) carrying the error + next_run_at", async () => {
    const t = typeFor("failretry");
    const born = await createTask(t); // default max_retries 3
    const correlation = String(born.correlation_id);
    const id = String(born.id);

    await claim(t, "worker-fr");
    const failed = (await rpc(serviceClient()).rpc("hq_ai_task_fail", {
      p_task_id: id,
      p_lease_owner: "worker-fr",
      p_error: "transient upstream timeout",
      p_retryable: true,
    })) as Res<unknown>;
    expect(failed.error, failed.error?.message).toBeNull();
    expect(taskOf(failed.data)?.status).toBe("pending"); // re-queued

    const ev = await eventsByVerb(correlation);
    const retried = requireEvent(ev, "task.retried");
    expect(retried.actor_type).toBe("system"); // unassigned worker
    expect(retried.actor_id).toBe("worker-fr");
    expect(retried.severity).toBe("warn");
    const p = retried.payload as Row;
    expect(p.reason).toBe("worker_error");
    expect(String(p.error)).toContain("transient upstream timeout");
    expect(Number(p.retry_count)).toBe(1);
    expect(p.next_run_at).toBeTruthy();
    // No terminal event was emitted.
    expect(ev["task.failed"]).toBeUndefined();
  });

  it("fail(retryable=false) emits task.failed (warn, reason=worker_error) — terminal", async () => {
    const t = typeFor("failterm");
    const born = await createTask(t);
    const correlation = String(born.correlation_id);
    const id = String(born.id);

    await claim(t, "worker-ft");
    const failed = (await rpc(serviceClient()).rpc("hq_ai_task_fail", {
      p_task_id: id,
      p_lease_owner: "worker-ft",
      p_error: "permanent: malformed payload",
      p_retryable: false,
    })) as Res<unknown>;
    expect(failed.error, failed.error?.message).toBeNull();
    expect(taskOf(failed.data)?.status).toBe("failed");

    const ev = await eventsByVerb(correlation);
    const failedEv = requireEvent(ev, "task.failed");
    expect(failedEv.actor_type).toBe("system");
    expect(failedEv.severity).toBe("warn");
    expect((failedEv.payload as Row).reason).toBe("worker_error");
    expect(ev["task.retried"]).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // reap — the SYSTEM acts; reason=lease_expired; the dead worker is named.
  // ─────────────────────────────────────────────────────────────────────────
  it("reap(retries remain) emits task.retried as SYSTEM with reason=lease_expired + dead_lease_owner", async () => {
    const t = typeFor("reapretry");
    const born = await createTask(t); // default max_retries 3
    const correlation = String(born.correlation_id);
    const id = String(born.id);

    await claim(t, "doomed-worker", 300);
    await expireLease(id);
    const reaped = (await rpc(serviceClient()).rpc("hq_ai_task_reap", {
      p_task_type: t,
      p_limit: 10,
    })) as Res<number>;
    expect(reaped.error, reaped.error?.message).toBeNull();
    expect(Number(reaped.data)).toBeGreaterThanOrEqual(1);

    const ev = await eventsByVerb(correlation);
    const retried = requireEvent(ev, "task.retried");
    // The honest actor is the SYSTEM — a worker died; this is NOT a worker-reported retry.
    expect(retried.actor_type).toBe("system");
    expect(retried.actor_id).toBe("system");
    expect(retried.severity).toBe("warn");
    const p = retried.payload as Row;
    expect(p.reason).toBe("lease_expired"); // the distinguishing signal vs worker_error
    expect(p.dead_lease_owner).toBe("doomed-worker"); // who held the lease that lapsed
    expect(Number(p.retry_count)).toBe(1);
  });

  it("reap(retries exhausted) emits task.failed as SYSTEM with reason=lease_expired", async () => {
    const t = typeFor("reapdead");
    const born = await createTask(t, { p_max_retries: 0 }); // no retries → reaper fails it terminally
    const correlation = String(born.correlation_id);
    const id = String(born.id);

    await claim(t, "dead-worker", 300);
    await expireLease(id);
    const reaped = (await rpc(serviceClient()).rpc("hq_ai_task_reap", {
      p_task_type: t,
      p_limit: 10,
    })) as Res<number>;
    expect(reaped.error, reaped.error?.message).toBeNull();
    expect(Number(reaped.data)).toBeGreaterThanOrEqual(1);

    const ev = await eventsByVerb(correlation);
    const failedEv = requireEvent(ev, "task.failed");
    expect(failedEv.actor_type).toBe("system");
    expect(failedEv.severity).toBe("warn");
    const p = failedEv.payload as Row;
    expect(p.reason).toBe("lease_expired");
    expect(p.dead_lease_owner).toBe("dead-worker");
    expect(ev["task.retried"]).toBeUndefined();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Silence — heartbeat and checkpoint are liveness / internal state, not facts.
  // ─────────────────────────────────────────────────────────────────────────
  it("heartbeat and checkpoint emit NOTHING — only create + claim are on the spine", async () => {
    const t = typeFor("silent");
    const born = await createTask(t);
    const correlation = String(born.correlation_id);
    const id = String(born.id);

    await claim(t, "worker-s");
    const hb = (await rpc(serviceClient()).rpc("hq_ai_task_heartbeat", {
      p_task_id: id,
      p_lease_owner: "worker-s",
      p_lease_seconds: 600,
    })) as Res<boolean>;
    expect(hb.error, hb.error?.message).toBeNull();
    expect(hb.data).toBe(true);

    const cp = (await rpc(serviceClient()).rpc("hq_ai_task_checkpoint", {
      p_task_id: id,
      p_lease_owner: "worker-s",
      p_result: { progress: 0.5 },
    })) as Res<boolean>;
    expect(cp.error, cp.error?.message).toBeNull();
    expect(cp.data).toBe(true);

    // Exactly two events — heartbeat and checkpoint added none.
    const verbs = (await eventsOrdered(correlation)).map((e) => String(e.verb));
    expect(verbs).toEqual(["task.created", "task.claimed"]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Correlation threading — a whole lifecycle is ONE ordered trace.
  // ─────────────────────────────────────────────────────────────────────────
  it("threads a full lifecycle into one correlation_id as an ordered verb sequence", async () => {
    const t = typeFor("lifecycle");
    const born = await createTask(t);
    const correlation = String(born.correlation_id);
    const id = String(born.id);

    // create → claim → fail(retry) → re-claim → complete.
    await claim(t, "w1");
    const f = (await rpc(serviceClient()).rpc("hq_ai_task_fail", {
      p_task_id: id,
      p_lease_owner: "w1",
      p_error: "retry me",
      p_retryable: true,
    })) as Res<unknown>;
    expect(f.error, f.error?.message).toBeNull();

    // Clear the backoff so we can re-claim immediately within the test.
    await db(serviceClient()).from("hq_ai_tasks").update({ scheduled_at: null }).eq("id", id);
    const reclaimed = await claim(t, "w2");
    expect(String(reclaimed?.id)).toBe(id);

    const done = (await rpc(serviceClient()).rpc("hq_ai_task_complete", {
      p_task_id: id,
      p_lease_owner: "w2",
      p_result: { ok: true },
    })) as Res<unknown>;
    expect(done.error, done.error?.message).toBeNull();
    expect(taskOf(done.data)?.status).toBe("completed");

    // The trace is exact and ordered — one correlation_id, the whole story.
    const verbs = (await eventsOrdered(correlation)).map((e) => String(e.verb));
    expect(verbs).toEqual([
      "task.created",
      "task.claimed",
      "task.retried",
      "task.claimed",
      "task.completed",
    ]);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The emit helper is not a public door — service-role only, like every entry point.
  // ─────────────────────────────────────────────────────────────────────────
  it("the hq_ai_task_emit helper is not EXECUTE-able by anon (service-role only)", async () => {
    // It takes a composite hq_ai_tasks arg we cannot easily forge over PostgREST, but
    // the privilege check fires BEFORE argument binding — anon EXECUTE is refused.
    const res = (await rpc(anonClient()).rpc("hq_ai_task_emit", {
      p_verb: "task.created",
      p_actor_type: "system",
      p_actor_id: "system",
      p_severity: "info",
    })) as Res<unknown>;
    expect(res.error, "anon must not EXECUTE hq_ai_task_emit").not.toBeNull();
  });
});
