import "server-only";

/**
 * CrewFlow HQ — Marketing AI executive runner (exec execution path).
 *
 * Drains a `marketing_review` task off the generic Task Engine through the canonical
 * runner SDK and completes it with an explainable review of the deterministic Marketing
 * board (`gatherMarketingBoard`). Marketing carries no red/amber status field, so its
 * findings come from the board's own honest GAPS (channel attribution, CAC, SEO — no
 * source wired yet). Same engine surface as the roster runners (Reference Employee Rule).
 *
 * DETERMINISTIC (no model), COMPUTES + REPORTS only, enqueue-only queue write.
 */

import { gatherMarketingBoard } from "@/server/services/hq-marketing";
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

const MARKETING_EXEC_SLUG = "marketing-ai";
const MARKETING_EXEC_TASK_TYPE = "marketing_review";
const MARKETING_EXEC_SOURCES = ["demo_requests", "organizations"];

const marketingExecHandler: TaskHandler = async () => {
  const board = await gatherMarketingBoard();
  return summariseExecReview(
    {
      role: MARKETING_EXEC_SLUG,
      roleLabel: "Marketing",
      metrics: toExecMetrics(board.metrics),
      signals: [],
      sources: MARKETING_EXEC_SOURCES,
    },
    new Date(),
  );
};

export async function enqueueMarketingReview(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveExecIdentity(MARKETING_EXEC_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: MARKETING_EXEC_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${MARKETING_EXEC_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-marketing-exec-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runMarketingReviewTask(): Promise<ExecRunOutcome> {
  const { identity } = await resolveExecIdentity(MARKETING_EXEC_SLUG);
  registerTaskHandler(MARKETING_EXEC_TASK_TYPE, identity, marketingExecHandler);
  return normaliseExecOutcome(
    await runReadyTask(MARKETING_EXEC_TASK_TYPE, marketingExecHandler, identity),
  );
}

export async function drainMarketingReviewTasks(
  limit = 2,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveExecIdentity(MARKETING_EXEC_SLUG);
  registerTaskHandler(MARKETING_EXEC_TASK_TYPE, identity, marketingExecHandler);
  const summary = await drainTaskType(
    MARKETING_EXEC_TASK_TYPE,
    marketingExecHandler,
    identity,
    { maxTasks: limit },
  );
  return { ok: true, ...summary };
}

export { MARKETING_EXEC_SLUG, MARKETING_EXEC_TASK_TYPE };
