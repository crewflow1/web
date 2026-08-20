import "server-only";

/**
 * CrewFlow HQ — CFO AI executive runner (exec execution path).
 *
 * Gives the `cfo-ai` executive a REAL execution path: it drains a `cfo_review` task off
 * the generic Task Engine through the canonical runner SDK and completes it with an
 * explainable review of the finance domain. The CFO owns finance STRATEGY, so it reads
 * the SAME deterministic finance board as Finance AI (`gatherFinanceBoard`) — the
 * strategic lens is the attribution, the figures are the one source of truth. Same
 * engine surface as the roster runners (Reference Employee Rule).
 *
 * Honesty + safety: DETERMINISTIC (no model), COMPUTES + REPORTS only
 * (requiresHumanApproval/autonomousApply pinned in the result), and the only
 * Task-Engine write is the sanctioned enqueue entry point.
 */

import { gatherFinanceBoard } from "@/server/services/hq-finance";
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

const CFO_EXEC_SLUG = "cfo-ai";
const CFO_EXEC_TASK_TYPE = "cfo_review";
const CFO_EXEC_SOURCES = ["organizations", "billing_invoices"];

const cfoExecHandler: TaskHandler = async () => {
  const board = await gatherFinanceBoard();
  return summariseExecReview(
    {
      role: CFO_EXEC_SLUG,
      roleLabel: "CFO",
      metrics: toExecMetrics(board.metrics),
      signals: [],
      sources: CFO_EXEC_SOURCES,
    },
    new Date(),
  );
};

export async function enqueueCfoReview(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveExecIdentity(CFO_EXEC_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: CFO_EXEC_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${CFO_EXEC_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-cfo-exec-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runCfoReviewTask(): Promise<ExecRunOutcome> {
  const { identity } = await resolveExecIdentity(CFO_EXEC_SLUG);
  registerTaskHandler(CFO_EXEC_TASK_TYPE, identity, cfoExecHandler);
  return normaliseExecOutcome(
    await runReadyTask(CFO_EXEC_TASK_TYPE, cfoExecHandler, identity),
  );
}

export async function drainCfoReviewTasks(
  limit = 2,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveExecIdentity(CFO_EXEC_SLUG);
  registerTaskHandler(CFO_EXEC_TASK_TYPE, identity, cfoExecHandler);
  const summary = await drainTaskType(CFO_EXEC_TASK_TYPE, cfoExecHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

export { CFO_EXEC_SLUG, CFO_EXEC_TASK_TYPE };
