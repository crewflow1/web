import { afterAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { drainReadySagaSteps } from "@/server/services/hq-workflow";
import {
  sagaStepHandler,
  SAGA_STEP_TASK_TYPE,
} from "@/server/services/hq-saga-step-runner";
import { enqueueTask } from "@/server/services/hq-tasks";
import { runReadyTask, type EmployeeIdentity, type RunContext } from "@/server/sdk/tasks";

/**
 * The `saga_step` lifecycle — real-Postgres proof (roadmap G6: the missing handler).
 *
 * Before this handler existed, `dispatchOrSyncStep` enqueued every dispatched saga
 * step as a `saga_step` task that NOTHING ever claimed — so steps stuck `running`
 * and no saga could ever reach `done`. This suite proves, against the live engine
 * (hq_ai_task_claim/complete/fail — atomic claim, real retries, real dedupe) plus
 * the live saga substrate (migration 20261104000000):
 *
 *   • FULL LIFECYCLE — a 2-step chained saga, driven ONLY by repeated autonomous
 *     drain ticks, reaches saga `done`: dispatch → claim → deterministic execution
 *     → task completed → step done → dependent released → saga done;
 *   • FAILURE PATH — a step whose dependency is human-gated (never done) fails
 *     retryably, exhausts max_retries through the REAL engine, lands terminal
 *     `failed`, and the drain escalates honestly: step `failed`, saga `blocked`
 *     (the saga vocabulary's terminal-failure state — there is no 'failed' saga
 *     status in the CHECK constraint and none is invented);
 *   • REPAIR PATH — a pre-existing queued-orphaned task (the exact stuck shape the
 *     defect produced: linked step `running`, task `pending`) is recovered by ONE
 *     ordinary drain tick, with no data surgery;
 *   • CONCURRENCY — two parallel claims of the same task execute the handler
 *     EXACTLY once (FOR UPDATE SKIP LOCKED), completing the task once.
 *
 * Saga/step/event rows persist by design (hq_saga_events is append-only with
 * ON DELETE RESTRICT — same as the foundation suite); the tasks this suite creates
 * are deleted on teardown.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  in(column: string, values: ReadonlyArray<unknown>): Sel;
  order(column: string, opts?: { ascending?: boolean }): Sel;
  single(): PromiseLike<Res<Row>>;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface InsertChain extends Thenable {
  select(columns?: string): Sel;
}
interface UpdChain extends Thenable {
  eq(column: string, value: unknown): UpdChain;
  select(columns?: string): Sel;
}
interface DelChain extends Thenable {
  eq(column: string, value: unknown): DelChain;
  in(column: string, values: ReadonlyArray<unknown>): DelChain;
}
type Thenable = PromiseLike<{ error: { message: string } | null }>;
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): InsertChain;
  update(values: Row): UpdChain;
  delete(): DelChain;
}
interface Db {
  from(table: string): Table;
}
const db = (): Db => serviceClient() as unknown as Db;

function alpha(n: number): string {
  const a = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}
const TOKEN = `g6saga${alpha(8)}`;
const createdTaskIds: string[] = [];

const STEP_COLS = "id, saga_id, ordinal, title, department, status, hq_ai_task_id";

async function seedSaga(tag: string, status = "planned"): Promise<Row> {
  const res = await db()
    .from("hq_workflow_sagas")
    .insert({ title: `${TOKEN}-${tag}`, template_key: null, status })
    .select("id, title, status")
    .single();
  expect(res.error, res.error?.message).toBeNull();
  return res.data as Row;
}

async function seedStep(
  sagaId: string,
  ordinal: number,
  dep: number | null,
  department = "Engineering",
): Promise<Row> {
  const res = await db()
    .from("hq_saga_steps")
    .insert({
      saga_id: sagaId,
      ordinal,
      title: `${TOKEN} step ${ordinal}`,
      department,
      role: "engineer",
      depends_on_ordinal: dep,
      status: "pending",
    })
    .select(STEP_COLS)
    .single();
  expect(res.error, res.error?.message).toBeNull();
  return res.data as Row;
}

async function readSagaRow(id: string): Promise<Row> {
  const res = await db().from("hq_workflow_sagas").select("id, status").eq("id", id).single();
  expect(res.error, res.error?.message).toBeNull();
  return res.data as Row;
}

async function readSteps(sagaId: string): Promise<Row[]> {
  const res = await db()
    .from("hq_saga_steps")
    .select(STEP_COLS)
    .eq("saga_id", sagaId)
    .order("ordinal", { ascending: true });
  expect(res.error, res.error?.message).toBeNull();
  return res.data ?? [];
}

async function readTask(id: string): Promise<Row> {
  const res = await db()
    .from("hq_ai_tasks")
    .select("id, task_type, status, retry_count, max_retries, result, error_message")
    .eq("id", id)
    .single();
  expect(res.error, res.error?.message).toBeNull();
  return res.data as Row;
}

/** Track every saga_step task linked to this suite's steps, for teardown. */
async function trackTasksOf(sagaId: string): Promise<void> {
  for (const s of await readSteps(sagaId)) {
    const t = s.hq_ai_task_id;
    if (typeof t === "string" && !createdTaskIds.includes(t)) createdTaskIds.push(t);
  }
}

describeIntegration("saga_step · full lifecycle against the live engine (G6)", () => {
  afterAll(async () => {
    if (createdTaskIds.length > 0) {
      await db().from("hq_ai_tasks").delete().in("id", createdTaskIds);
    }
  });

  it(
    "FULL LIFECYCLE: a 2-step chained saga reaches done on autonomous drain ticks alone",
    { timeout: 60_000 },
    async () => {
      const saga = await seedSaga("lifecycle");
      const sid = String(saga.id);
      await seedStep(sid, 1, null); // Engineering — ungated
      await seedStep(sid, 2, 1); // depends on step 1

      // Drive ONLY the autonomous drain — no manual advance, no direct writes.
      let status = "planned";
      let passes = 0;
      const dispatchedEver = { steps: 0, executed: 0 };
      while (status !== "done" && passes < 8) {
        const summary = await drainReadySagaSteps({ limit: 200 });
        dispatchedEver.steps += summary.steps_dispatched;
        dispatchedEver.executed += summary.step_tasks?.completed ?? 0;
        expect(summary.errors).toBe(0);
        status = String((await readSagaRow(sid)).status);
        passes++;
        await trackTasksOf(sid);
      }

      // The saga COMPLETED — the exact thing that was structurally impossible before.
      expect(status).toBe("done");
      const steps = await readSteps(sid);
      expect(steps.map((s) => s.status)).toEqual(["done", "done"]);
      expect(dispatchedEver.steps).toBeGreaterThanOrEqual(2);
      expect(dispatchedEver.executed).toBeGreaterThanOrEqual(2);

      // Each step's task is terminal 'completed' and carries the deterministic
      // execution artifact — no fabricated department output.
      for (const s of steps) {
        const task = await readTask(String(s.hq_ai_task_id));
        expect(task.status).toBe("completed");
        const result = task.result as Row | null;
        const exec = (result?.step_execution ?? null) as Row | null;
        expect(exec?.kind).toBe("saga_step_execution");
        expect((exec?.step as Row | undefined)?.id).toBe(s.id);
      }
    },
  );

  it(
    "FAILURE PATH: real retries exhaust → task failed → step failed → saga blocked",
    { timeout: 60_000 },
    async () => {
      // Step 1 is Marketing (approval-gated) so the autonomous drain NEVER
      // dispatches it — step 2's dependency can never become done, which makes
      // its handler failure deterministic and RETRYABLE.
      const saga = await seedSaga("failure", "running");
      const sid = String(saga.id);
      await seedStep(sid, 1, null, "Marketing");
      const step2 = await seedStep(sid, 2, 1);

      // A durable task for step 2, created through the sanctioned entry point with
      // the dispatch path's own dedupe key — the "wrongly-dispatched durable task"
      // shape. max_retries=1 ⇒ one retry, then terminal.
      const enq = await enqueueTask({
        taskType: SAGA_STEP_TASK_TYPE,
        payload: { saga_id: sid, step_id: step2.id },
        subjectKind: "saga_step",
        subjectId: String(step2.id),
        dedupeKey: `saga_step:${step2.id}`,
        maxRetries: 1,
        origin: "saga",
      });
      expect(enq.ok, enq.ok ? undefined : enq.error).toBe(true);
      if (!enq.ok) return;
      const taskId = enq.task.id;
      createdTaskIds.push(taskId);

      // Link the step the way the dispatch path would have (stuck-running shape).
      const linked = await db()
        .from("hq_saga_steps")
        .update({ hq_ai_task_id: taskId, status: "running" })
        .eq("id", String(step2.id))
        .select(STEP_COLS)
        .single();
      expect(linked.error, linked.error?.message).toBeNull();

      // Tick 1: claim → handler throws (dependency not done) → engine RE-QUEUES.
      await drainReadySagaSteps({ limit: 200 });
      const afterFirst = await readTask(taskId);
      expect(afterFirst.status).toBe("pending"); // retried, not terminal
      expect(Number(afterFirst.retry_count)).toBe(1);

      // The retry is scheduled with backoff — pull it due so tick 2 can claim it.
      const nudge = await db()
        .from("hq_ai_tasks")
        .update({ scheduled_at: new Date(Date.now() - 1000).toISOString() })
        .eq("id", taskId)
        .select("id");
      expect(nudge.error, nudge.error?.message).toBeNull();

      // Tick 2: claim → throw again → retries exhausted → TERMINAL failed.
      // The same tick's sync maps failed → step failed; recompute → saga blocked.
      const summary = await drainReadySagaSteps({ limit: 200 });
      expect(summary.step_tasks?.failed ?? 0).toBeGreaterThanOrEqual(1);

      const terminal = await readTask(taskId);
      expect(terminal.status).toBe("failed");
      expect(String(terminal.error_message)).toMatch(/dependency/);

      const steps = await readSteps(sid);
      expect(steps.find((s) => s.id === step2.id)?.status).toBe("failed");
      // Step 1 was HELD for a human (gated), never dispatched.
      expect(steps.find((s) => String(s.ordinal) === "1")?.status).toBe("pending");
      expect((await readSagaRow(sid)).status).toBe("blocked");
    },
  );

  it(
    "REPAIR PATH: the queued-orphaned stuck shape recovers on ONE ordinary tick",
    { timeout: 60_000 },
    async () => {
      // The exact shape the defect produced: a linked step stuck 'running' with a
      // 'pending' task nothing ever claimed.
      const saga = await seedSaga("repair", "running");
      const sid = String(saga.id);
      const step = await seedStep(sid, 1, null);
      const enq = await enqueueTask({
        taskType: SAGA_STEP_TASK_TYPE,
        payload: { saga_id: sid, step_id: step.id },
        subjectKind: "saga_step",
        subjectId: String(step.id),
        dedupeKey: `saga_step:${step.id}`,
        origin: "saga",
      });
      expect(enq.ok, enq.ok ? undefined : enq.error).toBe(true);
      if (!enq.ok) return;
      createdTaskIds.push(enq.task.id);
      const linked = await db()
        .from("hq_saga_steps")
        .update({ hq_ai_task_id: enq.task.id, status: "running" })
        .eq("id", String(step.id))
        .select(STEP_COLS)
        .single();
      expect(linked.error, linked.error?.message).toBeNull();

      // ONE ordinary autonomous tick — no data surgery.
      await drainReadySagaSteps({ limit: 200 });

      expect((await readTask(enq.task.id)).status).toBe("completed");
      const steps = await readSteps(sid);
      expect(steps[0]?.status).toBe("done");
      expect((await readSagaRow(sid)).status).toBe("done");
    },
  );

  it(
    "CONCURRENCY: two parallel claims execute the handler exactly once",
    { timeout: 60_000 },
    async () => {
      // Quiesce the saga_step queue first: earlier suites may have left active
      // sagas whose steps the ticks above dispatched — the race below must have
      // EXACTLY one claimable task.
      for (let i = 0; i < 10; i++) {
        const s = await drainReadySagaSteps({ limit: 200 });
        if ((s.step_tasks?.claimed ?? 0) === 0 && s.steps_dispatched === 0) break;
      }

      const saga = await seedSaga("concurrency", "running");
      const sid = String(saga.id);
      const step = await seedStep(sid, 1, null);
      const enq = await enqueueTask({
        taskType: SAGA_STEP_TASK_TYPE,
        payload: { saga_id: sid, step_id: step.id },
        subjectKind: "saga_step",
        subjectId: String(step.id),
        dedupeKey: `saga_step:${step.id}`,
        origin: "saga",
      });
      expect(enq.ok, enq.ok ? undefined : enq.error).toBe(true);
      if (!enq.ok) return;
      createdTaskIds.push(enq.task.id);

      let executions = 0;
      const counting = async (ctx: RunContext) => {
        executions++;
        return sagaStepHandler(ctx);
      };
      const identity: EmployeeIdentity = {
        employeeId: "00000000-0000-0000-0000-000000000000",
        slug: "workflow-ai",
      };

      const [a, b] = await Promise.all([
        runReadyTask(SAGA_STEP_TASK_TYPE, counting, identity),
        runReadyTask(SAGA_STEP_TASK_TYPE, counting, identity),
      ]);

      const statuses = [a.status, b.status].sort();
      // Exactly one runner won the atomic claim; the other found the queue empty.
      expect(statuses).toContain("completed");
      expect(statuses).toContain("empty");
      expect(executions).toBe(1);
      expect((await readTask(enq.task.id)).status).toBe("completed");
    },
  );
});
