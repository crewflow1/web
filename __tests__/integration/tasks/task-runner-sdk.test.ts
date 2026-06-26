import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import {
  claimTask,
  completeTask,
  enqueueTask,
  reapTasks,
} from "@/server/services/hq-tasks";
import {
  clearTaskHandlers,
  drainTaskType,
  NonRetryableError,
  registerTaskHandler,
  runEmployee,
  runReadyTask,
  type RunContext,
  type RunnerIdentity,
} from "@/server/sdk/tasks";

/**
 * The task-runner SDK — real-Postgres proof (CEO Directive #012 / D-02, PR-C).
 *
 * `task-engine.test.ts` already proves the SQL ENTRY POINTS against a live DB
 * (atomic claim, priority order, lease/heartbeat/reaper, backoff, dedupe, the
 * guard, RLS). THIS suite proves the TypeScript LAYER PR-C adds composes those
 * proven primitives correctly:
 *
 *   • the service wrappers return the house `{ ok }` unions the runner branches on
 *     (claim → task | empty; complete with a stale lease → lease_lost; reap → count);
 *   • the run-loop turns a handler's RETURN into completion and its THROW into a
 *     lease-guarded failure (retryable, or terminal for NonRetryableError) — the
 *     handler never touches a terminal entry point (rules 3 & 4);
 *   • ctx.tasks.checkpoint persists a partial result mid-run;
 *   • ctx.tasks.create auto-threads provenance (parent + correlation + createdBy);
 *   • drain is claim-one-and-exit — it empties a backlog and honours the cap;
 *   • runEmployee drains an employee's registered types via the registry.
 *
 * Runs only against a live DB (describeIntegration). Every task is tagged with a
 * per-run task_type token and deleted on teardown (DELETE is unguarded).
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  in(column: string, values: ReadonlyArray<unknown>): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface UpdChain extends PromiseLike<{ error: { message: string } | null }> {
  eq(column: string, value: unknown): UpdChain;
}
interface DelChain extends PromiseLike<{ error: { message: string } | null }> {
  in(column: string, values: ReadonlyArray<unknown>): DelChain;
}
interface Table {
  select(columns?: string): Sel;
  update(values: Row): UpdChain;
  delete(): DelChain;
}
const tbl = (): Table =>
  (serviceClient() as unknown as { from(t: string): Table }).from("hq_ai_tasks");

function alpha(n: number): string {
  const a = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

const TOKEN = `it_sdk_${alpha(8)}`;
const typeFor = (tag: string) => `${TOKEN}_${tag}`;

const EMP = "00000000-0000-4000-8000-0000000000aa";
const IDENTITY: RunnerIdentity = { employeeId: EMP, slug: "it-runner" };

async function readRow(id: string): Promise<Row | null> {
  const res = await tbl().select("*").eq("id", id).maybeSingle();
  expect(res.error, res.error?.message).toBeNull();
  return res.data;
}

describeIntegration("The task-runner SDK · run-loop over the live engine (Directive #012 / D-02, PR-C)", () => {
  beforeAll(async () => {
    const probe = await tbl().select("id");
    expect(probe.error, probe.error?.message).toBeNull();
  });

  afterAll(async () => {
    clearTaskHandlers();
    const mine = await tbl().select("id, task_type");
    const ids = (mine.data ?? [])
      .filter((r) => String(r.task_type).startsWith(TOKEN))
      .map((r) => String(r.id));
    if (ids.length) await tbl().delete().in("id", ids);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Service wrappers — the unions the runner branches on.
  // ─────────────────────────────────────────────────────────────────────────
  it("claimTask returns task:null on an empty queue (a clean 'nothing to do')", async () => {
    const res = await claimTask(typeFor("empty"), "owner");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.task).toBeNull();
  });

  it("completeTask with a stale lease returns reason:'lease_lost' (not a crash)", async () => {
    const t = typeFor("lease");
    const created = await enqueueTask({ taskType: t });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const claimed = await claimTask(t, "owner-A");
    expect(claimed.ok && claimed.task).toBeTruthy();

    const wrong = await completeTask(created.task.id, "owner-B-not-the-holder");
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.reason).toBe("lease_lost");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // The run-loop — return → complete, throw → fail.
  // ─────────────────────────────────────────────────────────────────────────
  it("runs a handler to completion, persisting its returned result and clearing the lease", async () => {
    const t = typeFor("happy");
    const created = await enqueueTask({ taskType: t, payload: { in: 1 } });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    let sawTask = "";
    const outcome = await runReadyTask(t, async (ctx: RunContext) => {
      sawTask = ctx.task.id;
      expect(ctx.correlationId).toBe(created.task.correlation_id);
      return { verdict: "done" };
    }, IDENTITY);

    expect(outcome).toEqual({ status: "completed", taskId: created.task.id });
    expect(sawTask).toBe(created.task.id);

    const row = await readRow(created.task.id);
    expect(row?.status).toBe("completed");
    expect(row?.result).toEqual({ verdict: "done" });
    expect(row?.lease_owner).toBeNull();
    expect(row?.finished_at).toBeTruthy();
  });

  it("returns 'empty' when no task is ready (the handler never runs)", async () => {
    let ran = false;
    const outcome = await runReadyTask(typeFor("none"), async () => {
      ran = true;
    }, IDENTITY);
    expect(outcome).toEqual({ status: "empty" });
    expect(ran).toBe(false);
  });

  it("a throwing handler fails the task RETRYABLY — re-queued with backoff", async () => {
    const t = typeFor("retry");
    const created = await enqueueTask({ taskType: t, maxRetries: 1 });
    if (!created.ok) return;

    const outcome = await runReadyTask(t, async () => {
      throw new Error("transient upstream");
    }, IDENTITY);

    expect(outcome).toMatchObject({ status: "failed", retried: true });

    const row = await readRow(created.task.id);
    expect(row?.status).toBe("pending"); // re-queued
    expect(Number(row?.retry_count)).toBe(1);
    expect(new Date(String(row?.scheduled_at)).getTime()).toBeGreaterThan(Date.now()); // backoff
    expect(String(row?.error_message)).toContain("transient upstream");
  });

  it("NonRetryableError fails the task TERMINALLY (no retry, even with attempts left)", async () => {
    const t = typeFor("terminal");
    const created = await enqueueTask({ taskType: t, maxRetries: 5 });
    if (!created.ok) return;

    const outcome = await runReadyTask(t, async () => {
      throw new NonRetryableError("malformed input");
    }, IDENTITY);

    expect(outcome).toMatchObject({ status: "failed", retried: false });
    const row = await readRow(created.task.id);
    expect(row?.status).toBe("failed"); // terminal despite max_retries=5
    expect(row?.finished_at).toBeTruthy();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ctx.tasks — checkpoint + create.
  // ─────────────────────────────────────────────────────────────────────────
  it("ctx.tasks.checkpoint persists a partial result mid-run", async () => {
    const t = typeFor("checkpoint");
    const created = await enqueueTask({ taskType: t, maxRetries: 1 });
    if (!created.ok) return;

    // Checkpoint, then throw — so completion can't overwrite, proving the
    // checkpoint stuck on its own.
    await runReadyTask(t, async (ctx) => {
      await ctx.tasks.checkpoint({ progress: 0.5, stage: "mid" });
      throw new Error("stop after checkpoint");
    }, IDENTITY);

    const row = await readRow(created.task.id);
    expect(row?.result).toEqual({ progress: 0.5, stage: "mid" });
    expect(row?.status).toBe("pending"); // the throw re-queued it
  });

  it("ctx.tasks.create spawns a child that inherits parent + correlation + createdBy", async () => {
    const parentType = typeFor("parent");
    const childType = typeFor("child");
    const parent = await enqueueTask({ taskType: parentType });
    if (!parent.ok) return;

    let childId = "";
    const outcome = await runReadyTask(parentType, async (ctx) => {
      childId = await ctx.tasks.create({ taskType: childType, payload: { spawned: true } });
      return { childId };
    }, IDENTITY);

    expect(outcome.status).toBe("completed");
    expect(childId).toBeTruthy();

    const child = await readRow(childId);
    expect(child?.parent_task_id).toBe(parent.task.id);
    expect(child?.correlation_id).toBe(parent.task.correlation_id); // same trace
    expect(child?.created_by).toBe("it-runner"); // attributed to the employee
    expect(child?.status).toBe("pending");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Drain (claim-one-and-exit) + runEmployee.
  // ─────────────────────────────────────────────────────────────────────────
  it("drainTaskType empties a backlog and then exits", async () => {
    const t = typeFor("drain");
    for (let i = 0; i < 3; i++) await enqueueTask({ taskType: t, payload: { i } });

    let runs = 0;
    const summary = await drainTaskType(t, async () => {
      runs++;
      return { ok: true };
    }, IDENTITY);

    expect(runs).toBe(3);
    expect(summary).toMatchObject({ claimed: 3, completed: 3, failed: 0 });

    // A second drain finds nothing.
    const again = await drainTaskType(t, async () => ({}), IDENTITY);
    expect(again.claimed).toBe(0);
  });

  it("drainTaskType honours the maxTasks cap (bounded per invocation)", async () => {
    const t = typeFor("cap");
    for (let i = 0; i < 3; i++) await enqueueTask({ taskType: t });

    const summary = await drainTaskType(t, async () => ({}), IDENTITY, { maxTasks: 2 });
    expect(summary.completed).toBe(2);

    // One task remains claimable.
    const left = await claimTask(t, "probe");
    expect(left.ok && left.task).toBeTruthy();
  });

  it("runEmployee drains the employee's registered task types via the registry", async () => {
    const t = typeFor("employee");
    registerTaskHandler(t, IDENTITY, async () => ({ handled: true }));
    for (let i = 0; i < 2; i++) await enqueueTask({ taskType: t });

    const summary = await runEmployee({ identity: IDENTITY, taskTypes: [t] });
    expect(summary).toMatchObject({ claimed: 2, completed: 2 });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Reaper wrapper — crash recovery the cron drives.
  // ─────────────────────────────────────────────────────────────────────────
  it("reapTasks recovers a task whose lease has expired", async () => {
    const t = typeFor("reap");
    const created = await enqueueTask({ taskType: t });
    if (!created.ok) return;
    const claimed = await claimTask(t, "doomed-worker", 300);
    expect(claimed.ok && claimed.task).toBeTruthy();

    // Simulate a dead worker: force the lease into the past.
    const expire = await tbl()
      .update({ lease_expires_at: new Date(Date.now() - 60_000).toISOString() })
      .eq("id", created.task.id);
    expect(expire.error, expire.error?.message).toBeNull();

    const reaped = await reapTasks(t, 10);
    expect(reaped.ok).toBe(true);
    if (reaped.ok) expect(reaped.reaped).toBeGreaterThanOrEqual(1);

    const row = await readRow(created.task.id);
    expect(row?.status).toBe("pending"); // recovered, claimable again
    expect(row?.lease_owner).toBeNull();
  });
});
