import "server-only";

/**
 * CrewFlow HQ — Workflow AI runner (HQ roster completion).
 *
 * Gives the previously-dark `workflow-ai` roster identity REAL deterministic work: a saga
 * sequencing-health read over the workflow substrate, run as a Task-Engine task. It owns
 * NO tables — it drains a `workflow_sequencing` task off the generic Task Engine through
 * the canonical runner SDK (server/sdk/tasks.ts).
 *
 * Honesty + safety:
 *   • DETERMINISTIC — a read of hq_workflow_sagas.status and hq_saga_steps.status. NO LLM.
 *   • It REPORTS, it does not act: it launches no workflow and dispatches no step (the
 *     saga-drain cron owns dispatch).
 *   • Reads are SELECT-only and bounded; the only queue write is the sanctioned enqueue.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import {
  summariseWorkflow,
  type WorkflowSagaRow,
  type WorkflowStepRow,
} from "@/lib/hq/roster-workers";
import { enqueueTask } from "@/server/services/hq-tasks";
import {
  resolveWorkerIdentity,
  normaliseWorkerOutcome,
  type WorkerRunOutcome,
} from "@/server/services/hq-worker-runner-kit";
import {
  drainTaskType,
  registerTaskHandler,
  runReadyTask,
  type DrainSummary,
  type TaskHandler,
} from "@/server/sdk/tasks";

const WORKFLOW_AI_SLUG = "workflow-ai";
const WORKFLOW_TASK_TYPE = "workflow_sequencing";

const SAGA_WINDOW = 500;
const STEP_WINDOW = 1000;

async function readSignals(): Promise<{
  sagas: WorkflowSagaRow[];
  steps: WorkflowStepRow[];
}> {
  const admin = createAdminClient();

  const { data: sagaData, error: sagaErr } = await admin
    .from("hq_workflow_sagas" as never)
    .select("id, status")
    .order("updated_at", { ascending: false })
    .limit(SAGA_WINDOW);
  if (sagaErr) throw new Error(`hq-workflow-runner: saga read failed — ${sagaErr.message}`);

  const { data: stepData, error: stepErr } = await admin
    .from("hq_saga_steps" as never)
    .select("saga_id, status")
    .order("updated_at", { ascending: false })
    .limit(STEP_WINDOW);
  if (stepErr) throw new Error(`hq-workflow-runner: step read failed — ${stepErr.message}`);

  return {
    sagas: (sagaData ?? []) as unknown as WorkflowSagaRow[],
    steps: (stepData ?? []) as unknown as WorkflowStepRow[],
  };
}

const workflowHandler: TaskHandler = async () => {
  const { sagas, steps } = await readSignals();
  return summariseWorkflow(sagas, steps, new Date());
};

export async function enqueueWorkflowSequencing(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveWorkerIdentity(WORKFLOW_AI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: WORKFLOW_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${WORKFLOW_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-workflow-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runWorkflowTask(): Promise<WorkerRunOutcome> {
  const { identity } = await resolveWorkerIdentity(WORKFLOW_AI_SLUG);
  registerTaskHandler(WORKFLOW_TASK_TYPE, identity, workflowHandler);
  return normaliseWorkerOutcome(await runReadyTask(WORKFLOW_TASK_TYPE, workflowHandler, identity));
}

export async function drainWorkflowTasks(limit = 1): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveWorkerIdentity(WORKFLOW_AI_SLUG);
  registerTaskHandler(WORKFLOW_TASK_TYPE, identity, workflowHandler);
  const summary = await drainTaskType(WORKFLOW_TASK_TYPE, workflowHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

export { WORKFLOW_AI_SLUG, WORKFLOW_TASK_TYPE };
