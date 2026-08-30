import "server-only";

/**
 * CrewFlow HQ — the `saga_step` task runner (roadmap G6: the missing handler).
 *
 * THE DEFECT THIS CLOSES: `hq-workflow.ts` (`dispatchOrSyncStep`) enqueues every
 * dispatched saga step as an hq_ai_tasks row of task_type `"saga_step"` — but no
 * runner ever registered a handler for that type, so every dispatched step's task
 * sat `pending` forever, its step stuck `running`, and no saga could EVER reach
 * `done`. This file is the canonical handler + drain for that type, built on the
 * IDENTICAL canonical surface every other runner uses (registerTaskHandler /
 * runReadyTask / drainTaskType — the Reference Employee Rule), under the
 * `workflow-ai` identity that already owns the saga substrate's sequencing read
 * (server/services/hq-workflow-runner.ts).
 *
 * WHAT EXECUTING A STEP MEANS TODAY — honest and deterministic:
 *   • A saga step carries a department/role/title, NOT a tool action. The
 *     generative department execution path (the governor) and the executor apply
 *     authority both ship DARK, so there is no sanctioned way to "do" a
 *     department's creative work autonomously — and NOTHING here fakes one.
 *   • The step's deterministic work at the current stage is its EXECUTION RECORD:
 *     a bounded, real read of the step's position in its saga graph (the saga row,
 *     the step row, its dependency's REAL status), verified and persisted as the
 *     task's result artifact (`kind: "saga_step_execution"`). NO LLM, no external
 *     action, no fabricated department output.
 *   • Completion semantics: the runner (not the handler — XIII §21 rule 3) marks
 *     the task `completed`; the saga-drain's re-sync (`dispatchOrSyncStep`) then
 *     maps completed → step `done` (stepStatusForTask), dependents become ready,
 *     and `deriveSagaStatus` rolls the saga to `done` when every step is terminal.
 *     A saga CAN now complete end-to-end.
 *
 * LIFECYCLE GUARANTEES (all inherited from the engine, none re-implemented):
 *   • idempotent — claim is atomic (`hq_ai_task_claim`, FOR UPDATE SKIP LOCKED),
 *     so two concurrent drains execute a task once; a re-claim after a crash
 *     re-runs a PURE read (the only side write is the task's own result), and a
 *     step already terminal short-circuits to a no-op envelope;
 *   • retries — a retryable throw re-queues through `hq_ai_task_fail` until
 *     max_retries, then terminal `failed`; malformed input throws
 *     {@link NonRetryableError} (a retry cannot fix a missing step);
 *   • terminal failure escalates — the saga-drain re-sync maps a `failed` task to
 *     step `failed`, and the model rolls the saga to `blocked` (the saga
 *     vocabulary's honest terminal-failure state; there is no 'failed' saga
 *     status in the 20261104 CHECK constraint, and none is invented here);
 *   • timeout — the lease + the task-reaper cron (app/api/cron/task-reaper)
 *     recover an expired claim; nothing extra is needed here;
 *   • audit — the engine emits task.claimed/completed/failed on the spine
 *     in-transaction; the step-status move appends an immutable hq_saga_events
 *     row via the 20261104 trigger; and the execution itself is recorded via
 *     recordAdminActivity exactly like hq-workflow's other saga mutations.
 *
 * REPAIR PATH for the stuck backlog: none needed beyond this handler existing —
 * `hq_ai_task_claim` selects by task_type + status='pending' regardless of
 * assignment, so every queued-orphaned `saga_step` task becomes claimable the
 * moment `drainSagaStepTasks` runs (the saga-drain cron calls it every tick), and
 * the same tick's re-sync propagates the completions into the steps. No data
 * surgery, no migration.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { isTerminalStep, type StepStatus } from "@/lib/hq/workflow/model";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  resolveWorkerIdentity,
  normaliseWorkerOutcome,
  type WorkerRunOutcome,
} from "@/server/services/hq-worker-runner-kit";
import {
  drainTaskType,
  registerTaskHandler,
  runReadyTask,
  NonRetryableError,
  type DrainSummary,
  type RunContext,
  type TaskHandler,
} from "@/server/sdk/tasks";

/** The saga substrate's runtime identity — the same slug as the sequencing runner. */
export const SAGA_STEP_WORKER_SLUG = "workflow-ai";
/** The task_type `dispatchOrSyncStep` enqueues — the type this runner drains. */
export const SAGA_STEP_TASK_TYPE = "saga_step";

// ---------------------------------------------------------------------
// Reads — the same untyped-table shim the saga service uses (service-role-only
// HQ tables, not in the generated types; a typing convenience, not logic).
// ---------------------------------------------------------------------

type AdminClient = ReturnType<typeof createAdminClient>;

type StepRow = {
  id: string;
  saga_id: string;
  ordinal: number;
  title: string;
  department: string | null;
  role: string | null;
  depends_on_ordinal: number | null;
  hq_ai_task_id: string | null;
  status: StepStatus;
};

type SagaRow = {
  id: string;
  title: string;
  template_key: string | null;
  status: string;
};

interface Sel<T> extends PromiseLike<{ data: T[] | null; error: { message: string } | null }> {
  select(columns: string): Sel<T>;
  eq(column: string, value: unknown): Sel<T>;
  order(column: string, opts?: { ascending?: boolean }): Sel<T>;
  maybeSingle(): PromiseLike<{ data: T | null; error: { message: string } | null }>;
}

function table<T>(admin: AdminClient, name: string): Sel<T> {
  return admin.from(name as never) as unknown as Sel<T>;
}

const STEP_COLUMNS =
  "id, saga_id, ordinal, title, department, role, depends_on_ordinal, hq_ai_task_id, status";
const SAGA_COLUMNS = "id, title, template_key, status";

async function readStep(admin: AdminClient, stepId: string): Promise<StepRow | null> {
  const { data, error } = await table<StepRow>(admin, "hq_saga_steps")
    .select(STEP_COLUMNS)
    .eq("id", stepId)
    .maybeSingle();
  if (error) throw new Error(`saga-step-runner: step read failed — ${error.message}`);
  return data ?? null;
}

async function readSiblingSteps(admin: AdminClient, sagaId: string): Promise<StepRow[]> {
  const { data, error } = await table<StepRow>(admin, "hq_saga_steps")
    .select(STEP_COLUMNS)
    .eq("saga_id", sagaId)
    .order("ordinal", { ascending: true });
  if (error) throw new Error(`saga-step-runner: sibling read failed — ${error.message}`);
  return Array.isArray(data) ? data : [];
}

async function readSaga(admin: AdminClient, sagaId: string): Promise<SagaRow | null> {
  const { data, error } = await table<SagaRow>(admin, "hq_workflow_sagas")
    .select(SAGA_COLUMNS)
    .eq("id", sagaId)
    .maybeSingle();
  if (error) throw new Error(`saga-step-runner: saga read failed — ${error.message}`);
  return data ?? null;
}

// ---------------------------------------------------------------------
// The handler — business logic ONLY (XIII §21 rule 5). The runner owns
// claim/heartbeat/complete/fail; a return completes, a throw fails.
// ---------------------------------------------------------------------

/** Resolve the step id: the write-once payload first, the task subject as fallback. */
function stepIdOf(ctx: RunContext): string | null {
  const fromPayload = ctx.task.payload?.step_id;
  if (typeof fromPayload === "string" && fromPayload.length > 0) return fromPayload;
  if (ctx.task.subject_kind === "saga_step" && ctx.task.subject_id) return ctx.task.subject_id;
  return null;
}

/**
 * Execute ONE saga step deterministically. Exported so the concurrency proof can
 * wrap it with an invocation counter; production code reaches it only through
 * {@link runSagaStepTask} / {@link drainSagaStepTasks}.
 */
export const sagaStepHandler: TaskHandler = async (ctx) => {
  const stepId = stepIdOf(ctx);
  if (!stepId) {
    // Malformed input — a retry cannot conjure a step id. Terminal.
    throw new NonRetryableError("saga_step task carries no step_id (payload + subject empty)");
  }

  const admin = createAdminClient();
  const step = await readStep(admin, stepId);
  if (!step) {
    // The step row is gone (its saga was deleted; steps cascade). Terminal.
    throw new NonRetryableError(`saga step ${stepId} not found`);
  }

  // Idempotent re-claim: a step already terminal (done/skipped/failed) needs no
  // re-execution — complete as an explicit no-op so the task can leave the queue.
  if (isTerminalStep(step.status)) {
    return {
      summary: `saga step ${step.ordinal} ("${step.title}") already terminal (${step.status}) — no-op`,
      outcome: "already_terminal",
      step_id: step.id,
      saga_id: step.saga_id,
      step_status: step.status,
    };
  }

  const saga = await readSaga(admin, step.saga_id);
  if (!saga) {
    throw new NonRetryableError(`saga ${step.saga_id} not found for step ${stepId}`);
  }
  // A terminal saga is frozen — executing a straggler task for it would be work
  // on a dead saga. Complete as an explicit no-op (nothing to escalate).
  if (saga.status === "done" || saga.status === "abandoned") {
    return {
      summary: `saga ${saga.id} is terminal (${saga.status}) — step ${step.ordinal} not executed`,
      outcome: "saga_terminal",
      step_id: step.id,
      saga_id: saga.id,
      saga_status: saga.status,
    };
  }

  // Honour the graph edge with a REAL read: the dispatch path only enqueues ready
  // steps, but a task is durable — re-verify rather than assume. A not-yet-done
  // dependency is a RETRYABLE state (the dependency may complete), never terminal.
  const siblings = await readSiblingSteps(admin, step.saga_id);
  const dep =
    step.depends_on_ordinal === null
      ? null
      : (siblings.find((s) => s.ordinal === step.depends_on_ordinal) ?? null);
  if (step.depends_on_ordinal !== null && (!dep || dep.status !== "done")) {
    throw new Error(
      `saga step ${step.ordinal} dependency (ordinal ${step.depends_on_ordinal}) is not done — retry later`,
    );
  }

  // The deterministic execution record — the step's honest artifact at the current
  // stage. Real reads only; the generative department execution stays DARK and no
  // department output is fabricated. `executed_at` is the record's own timestamp.
  const execution = {
    kind: "saga_step_execution" as const,
    determinism:
      "deterministic sequencing execution — bounded reads of the saga graph; no LLM, no external action, no fabricated department output (generative execution is dark)",
    saga: { id: saga.id, title: saga.title, template_key: saga.template_key, status: saga.status },
    step: {
      id: step.id,
      ordinal: step.ordinal,
      title: step.title,
      department: step.department,
      role: step.role,
    },
    dependency: dep ? { ordinal: dep.ordinal, status: dep.status } : null,
    graph: { total_steps: siblings.length, position: step.ordinal },
    executed_at: new Date().toISOString(),
  };

  // The same immutable provenance record every other saga mutation writes
  // (hq-workflow's recordAdminActivity), as the system actor — the spine's
  // task.claimed/task.completed pair is emitted by the engine in-transaction.
  await recordAdminActivity({
    actorId: null,
    actorEmail: null,
    action: "saga.step_executed",
    targetTable: "hq_saga_steps",
    targetId: step.id,
    metadata: {
      saga_id: saga.id,
      task_id: ctx.task.id,
      ordinal: step.ordinal,
      department: step.department,
    },
  });

  return {
    summary: `executed saga step ${step.ordinal}/${siblings.length} ("${step.title}") of saga "${saga.title}" deterministically`,
    confidence: 1,
    outcome: "executed",
    step_execution: execution,
  };
};

// ---------------------------------------------------------------------
// The canonical runner surface — identical to every other runner file.
// ---------------------------------------------------------------------

/** Run AT MOST ONE ready `saga_step` task (claim-one-and-exit). */
export async function runSagaStepTask(): Promise<WorkerRunOutcome> {
  const { identity } = await resolveWorkerIdentity(SAGA_STEP_WORKER_SLUG);
  registerTaskHandler(SAGA_STEP_TASK_TYPE, identity, sagaStepHandler);
  return normaliseWorkerOutcome(
    await runReadyTask(SAGA_STEP_TASK_TYPE, sagaStepHandler, identity),
  );
}

/**
 * Drain ready `saga_step` tasks, bounded per tick. Called by the saga-drain
 * (`drainReadySagaSteps`) BEFORE its sync pass, so a tick both executes the
 * dispatched work and propagates the completions into the steps.
 */
export async function drainSagaStepTasks(
  limit = 25,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveWorkerIdentity(SAGA_STEP_WORKER_SLUG);
  registerTaskHandler(SAGA_STEP_TASK_TYPE, identity, sagaStepHandler);
  const summary = await drainTaskType(SAGA_STEP_TASK_TYPE, sagaStepHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}
