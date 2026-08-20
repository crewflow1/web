import "server-only";

/**
 * CrewFlow HQ — COO AI executive runner (exec execution path).
 *
 * Drains a `coo_review` task off the generic Task Engine through the canonical runner
 * SDK and completes it with an explainable review of the operations domain. The COO owns
 * operational EXECUTION, so it reviews the SAME deterministic Operations board as
 * Operations AI (`gatherOperationsBoard`) and reuses its signal extraction — the
 * strategic lens is the attribution, the figures are the one source of truth. Same
 * engine surface as the roster runners (Reference Employee Rule).
 *
 * DETERMINISTIC (no model), COMPUTES + REPORTS only, enqueue-only queue write.
 */

import { gatherOperationsBoard } from "@/server/services/hq-operations";
import {
  buildOperationsSignals,
  OPERATIONS_EXEC_SOURCES,
} from "@/server/services/hq-operations-exec-runner";
import { summariseExecReview } from "@/lib/hq/exec-runners";
import {
  resolveExecIdentity,
  normaliseExecOutcome,
  toExecMetrics,
  type ExecRunOutcome,
} from "@/server/services/hq-exec-runner-kit";
import { enqueueTask } from "@/server/services/hq-tasks";
import {
  drainTaskType,
  registerTaskHandler,
  runReadyTask,
  type DrainSummary,
  type TaskHandler,
} from "@/server/sdk/tasks";

const COO_EXEC_SLUG = "coo-ai";
const COO_EXEC_TASK_TYPE = "coo_review";

const cooExecHandler: TaskHandler = async () => {
  const board = await gatherOperationsBoard();
  return summariseExecReview(
    {
      role: COO_EXEC_SLUG,
      roleLabel: "COO",
      metrics: toExecMetrics(board.metrics),
      signals: buildOperationsSignals(board),
      sources: OPERATIONS_EXEC_SOURCES,
    },
    new Date(),
  );
};

export async function enqueueCooReview(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveExecIdentity(COO_EXEC_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: COO_EXEC_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${COO_EXEC_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-coo-exec-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runCooReviewTask(): Promise<ExecRunOutcome> {
  const { identity } = await resolveExecIdentity(COO_EXEC_SLUG);
  registerTaskHandler(COO_EXEC_TASK_TYPE, identity, cooExecHandler);
  return normaliseExecOutcome(
    await runReadyTask(COO_EXEC_TASK_TYPE, cooExecHandler, identity),
  );
}

export async function drainCooReviewTasks(
  limit = 2,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveExecIdentity(COO_EXEC_SLUG);
  registerTaskHandler(COO_EXEC_TASK_TYPE, identity, cooExecHandler);
  const summary = await drainTaskType(COO_EXEC_TASK_TYPE, cooExecHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

export { COO_EXEC_SLUG, COO_EXEC_TASK_TYPE };
