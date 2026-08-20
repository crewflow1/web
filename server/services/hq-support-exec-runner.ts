import "server-only";

/**
 * CrewFlow HQ — Support AI executive runner (exec execution path).
 *
 * Drains a `support_review` task off the generic Task Engine through the canonical
 * runner SDK and completes it with an explainable review of the deterministic Support
 * triage board (`gatherSupportBoard`). Findings are read straight from the active-ticket
 * priority mix (urgent / high backlog). Same engine surface as the roster runners
 * (Reference Employee Rule).
 *
 * DETERMINISTIC (no model), COMPUTES + REPORTS only, enqueue-only queue write.
 */

import { gatherSupportBoard } from "@/server/services/hq-support-ai";
import type { SupportBoard } from "@/lib/hq/support-ai";
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

const SUPPORT_EXEC_SLUG = "support-ai";
const SUPPORT_EXEC_TASK_TYPE = "support_review";
const SUPPORT_EXEC_SOURCES = ["support_tickets"];

function buildSupportSignals(board: SupportBoard): ExecSignal[] {
  const signals: ExecSignal[] = [];
  for (const p of board.priorityMix) {
    if (p.count <= 0) continue;
    if (p.key === "urgent") {
      signals.push({
        key: "priority_urgent",
        label: "Urgent tickets open",
        severity: "warning",
        detail: `${p.count} urgent ticket(s) active (${p.share}% of the active queue).`,
        source: "support_tickets",
      });
    } else if (p.key === "high") {
      signals.push({
        key: "priority_high",
        label: "High-priority tickets open",
        severity: "watch",
        detail: `${p.count} high-priority ticket(s) active (${p.share}% of the active queue).`,
        source: "support_tickets",
      });
    }
  }
  return signals;
}

const supportExecHandler: TaskHandler = async () => {
  const board = await gatherSupportBoard();
  return summariseExecReview(
    {
      role: SUPPORT_EXEC_SLUG,
      roleLabel: "Support",
      metrics: toExecMetrics(board.metrics),
      signals: buildSupportSignals(board),
      sources: SUPPORT_EXEC_SOURCES,
    },
    new Date(),
  );
};

export async function enqueueSupportReview(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveExecIdentity(SUPPORT_EXEC_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: SUPPORT_EXEC_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${SUPPORT_EXEC_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-support-exec-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runSupportReviewTask(): Promise<ExecRunOutcome> {
  const { identity } = await resolveExecIdentity(SUPPORT_EXEC_SLUG);
  registerTaskHandler(SUPPORT_EXEC_TASK_TYPE, identity, supportExecHandler);
  return normaliseExecOutcome(
    await runReadyTask(SUPPORT_EXEC_TASK_TYPE, supportExecHandler, identity),
  );
}

export async function drainSupportReviewTasks(
  limit = 2,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveExecIdentity(SUPPORT_EXEC_SLUG);
  registerTaskHandler(SUPPORT_EXEC_TASK_TYPE, identity, supportExecHandler);
  const summary = await drainTaskType(
    SUPPORT_EXEC_TASK_TYPE,
    supportExecHandler,
    identity,
    { maxTasks: limit },
  );
  return { ok: true, ...summary };
}

export { SUPPORT_EXEC_SLUG, SUPPORT_EXEC_TASK_TYPE };
