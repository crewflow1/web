import "server-only";

/**
 * CrewFlow HQ — Product AI executive runner (exec execution path).
 *
 * Drains a `product_review` task off the generic Task Engine through the canonical
 * runner SDK and completes it with an explainable review of the deterministic Product
 * board (`gatherProductBoard`) — the voice-of-customer / adoption signals. Findings come
 * from the board's own honest GAPS (competitor monitoring, roadmap prioritisation — no
 * source wired yet). Same engine surface as the roster runners (Reference Employee Rule).
 *
 * DETERMINISTIC (no model), COMPUTES + REPORTS only, enqueue-only queue write.
 */

import { gatherProductBoard } from "@/server/services/hq-product";
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

const PRODUCT_EXEC_SLUG = "product-ai";
const PRODUCT_EXEC_TASK_TYPE = "product_review";
const PRODUCT_EXEC_SOURCES = ["support_tickets", "organizations"];

const productExecHandler: TaskHandler = async () => {
  const board = await gatherProductBoard();
  return summariseExecReview(
    {
      role: PRODUCT_EXEC_SLUG,
      roleLabel: "Product",
      metrics: toExecMetrics(board.metrics),
      signals: [],
      sources: PRODUCT_EXEC_SOURCES,
    },
    new Date(),
  );
};

export async function enqueueProductReview(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveExecIdentity(PRODUCT_EXEC_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: PRODUCT_EXEC_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${PRODUCT_EXEC_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-product-exec-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runProductReviewTask(): Promise<ExecRunOutcome> {
  const { identity } = await resolveExecIdentity(PRODUCT_EXEC_SLUG);
  registerTaskHandler(PRODUCT_EXEC_TASK_TYPE, identity, productExecHandler);
  return normaliseExecOutcome(
    await runReadyTask(PRODUCT_EXEC_TASK_TYPE, productExecHandler, identity),
  );
}

export async function drainProductReviewTasks(
  limit = 2,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveExecIdentity(PRODUCT_EXEC_SLUG);
  registerTaskHandler(PRODUCT_EXEC_TASK_TYPE, identity, productExecHandler);
  const summary = await drainTaskType(
    PRODUCT_EXEC_TASK_TYPE,
    productExecHandler,
    identity,
    { maxTasks: limit },
  );
  return { ok: true, ...summary };
}

export { PRODUCT_EXEC_SLUG, PRODUCT_EXEC_TASK_TYPE };
