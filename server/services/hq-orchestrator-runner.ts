import "server-only";

/**
 * CrewFlow HQ — Orchestrator AI runner (HQ roster completion).
 *
 * Gives the previously-dark `orchestrator-ai` roster identity REAL deterministic work: a
 * task-routing picture over the shared Task-Engine queue, run as a Task-Engine task. It
 * owns NO tables — it drains an `orchestration_routing` task off the generic Task Engine
 * through the canonical runner SDK (server/sdk/tasks.ts).
 *
 * Honesty + safety:
 *   • DETERMINISTIC — a read of hq_ai_tasks status / task_type / assigned_employee_id (the
 *     SAME sanctioned SELECT the Boardroom uses). NO LLM.
 *   • It REPORTS, it does not act: it enqueues nothing and reassigns no work.
 *   • Reads are SELECT-only and bounded; it NEVER raw-writes the queue — the only queue
 *     write is the sanctioned enqueue entry point for its own review task.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { summariseOrchestration, type OrchestratorTaskRow } from "@/lib/hq/roster-workers";
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

const ORCHESTRATOR_AI_SLUG = "orchestrator-ai";
const ORCHESTRATOR_TASK_TYPE = "orchestration_routing";

const TASK_WINDOW = 1000;

async function readSignals(): Promise<{ tasks: OrchestratorTaskRow[] }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("hq_ai_tasks" as never)
    .select("status, task_type, assigned_employee_id")
    .order("created_at", { ascending: false })
    .limit(TASK_WINDOW);
  if (error) throw new Error(`hq-orchestrator-runner: task read failed — ${error.message}`);
  return { tasks: (data ?? []) as unknown as OrchestratorTaskRow[] };
}

const orchestratorHandler: TaskHandler = async () => {
  const { tasks } = await readSignals();
  return summariseOrchestration(tasks, new Date());
};

export async function enqueueOrchestrationRouting(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveWorkerIdentity(ORCHESTRATOR_AI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: ORCHESTRATOR_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${ORCHESTRATOR_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-orchestrator-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runOrchestrationTask(): Promise<WorkerRunOutcome> {
  const { identity } = await resolveWorkerIdentity(ORCHESTRATOR_AI_SLUG);
  registerTaskHandler(ORCHESTRATOR_TASK_TYPE, identity, orchestratorHandler);
  return normaliseWorkerOutcome(
    await runReadyTask(ORCHESTRATOR_TASK_TYPE, orchestratorHandler, identity),
  );
}

export async function drainOrchestrationTasks(limit = 1): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveWorkerIdentity(ORCHESTRATOR_AI_SLUG);
  registerTaskHandler(ORCHESTRATOR_TASK_TYPE, identity, orchestratorHandler);
  const summary = await drainTaskType(ORCHESTRATOR_TASK_TYPE, orchestratorHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

export { ORCHESTRATOR_AI_SLUG, ORCHESTRATOR_TASK_TYPE };
