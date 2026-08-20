import "server-only";

/**
 * CrewFlow HQ — Sales AI executive runner (exec execution path).
 *
 * Drains a `sales_review` task off the generic Task Engine through the canonical runner
 * SDK and completes it with an explainable review of the deterministic Sales-Orchestrator
 * board (`gatherSalesOrchestratorBoard`) — the unified pipeline + the three drains'
 * health. Findings are read straight from the drains' own failure counts. Same engine
 * surface as the roster runners (Reference Employee Rule).
 *
 * DETERMINISTIC (no model), COMPUTES + REPORTS only, enqueue-only queue write.
 */

import { gatherSalesOrchestratorBoard } from "@/server/services/hq-sales-orchestrator";
import type { SalesOrchestratorBoard } from "@/lib/hq/sales-orchestrator";
import { summariseExecReview, type ExecSignal } from "@/lib/hq/exec-runners";
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

const SALES_EXEC_SLUG = "sales-ai";
const SALES_EXEC_TASK_TYPE = "sales_review";
const SALES_EXEC_SOURCES = [
  "hq_sales_companies",
  "hq_ai_tasks",
  "hq_sales_timeline_events",
];

function buildSalesSignals(board: SalesOrchestratorBoard): ExecSignal[] {
  const signals: ExecSignal[] = [];
  if (!board.drains) return signals;
  for (const d of board.drains) {
    if (d.failed > 0) {
      signals.push({
        key: `drain_failed_${d.key}`,
        label: `${d.label} drain: failed tasks`,
        severity: "warning",
        detail: `${d.failed} failed task(s) in the ${d.label} drain (${d.backlog} backlog, ${d.inFlight} in flight).`,
        source: "hq_ai_tasks",
      });
    }
  }
  return signals;
}

const salesExecHandler: TaskHandler = async () => {
  const board = await gatherSalesOrchestratorBoard();
  return summariseExecReview(
    {
      role: SALES_EXEC_SLUG,
      roleLabel: "Sales",
      metrics: toExecMetrics(board.metrics),
      signals: buildSalesSignals(board),
      sources: SALES_EXEC_SOURCES,
    },
    new Date(),
  );
};

export async function enqueueSalesReview(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveExecIdentity(SALES_EXEC_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: SALES_EXEC_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${SALES_EXEC_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-sales-exec-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runSalesReviewTask(): Promise<ExecRunOutcome> {
  const { identity } = await resolveExecIdentity(SALES_EXEC_SLUG);
  registerTaskHandler(SALES_EXEC_TASK_TYPE, identity, salesExecHandler);
  return normaliseExecOutcome(
    await runReadyTask(SALES_EXEC_TASK_TYPE, salesExecHandler, identity),
  );
}

export async function drainSalesReviewTasks(
  limit = 2,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveExecIdentity(SALES_EXEC_SLUG);
  registerTaskHandler(SALES_EXEC_TASK_TYPE, identity, salesExecHandler);
  const summary = await drainTaskType(SALES_EXEC_TASK_TYPE, salesExecHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

export { SALES_EXEC_SLUG, SALES_EXEC_TASK_TYPE };
