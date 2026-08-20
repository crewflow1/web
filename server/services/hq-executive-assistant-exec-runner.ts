import "server-only";

/**
 * CrewFlow HQ — Executive-Assistant AI executive runner (exec execution path).
 *
 * Drains an `exec_assistant_review` task off the generic Task Engine through the
 * canonical runner SDK and completes it with an explainable review of the deterministic
 * Executive-Assistant board (`gatherExecutiveAssistantBoard`) — the cross-queue "what
 * needs the human now" digest. Findings are read straight from the board's prioritised
 * `needsHuman` list and any unreadable queues. Same engine surface as the roster runners
 * (Reference Employee Rule).
 *
 * DETERMINISTIC (no model), COMPUTES + REPORTS only, enqueue-only queue write.
 */

import { gatherExecutiveAssistantBoard } from "@/server/services/hq-executive-assistant";
import type { ExecutiveAssistantBoard } from "@/lib/hq/executive-assistant";
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

const EXEC_ASSISTANT_EXEC_SLUG = "exec-assistant-ai";
const EXEC_ASSISTANT_EXEC_TASK_TYPE = "exec_assistant_review";
const EXEC_ASSISTANT_EXEC_SOURCES = [
  "hq_approvals",
  "hq_decisions",
  "hq_ai_tasks",
  "admin_alert_state",
];

function buildExecAssistantSignals(board: ExecutiveAssistantBoard): ExecSignal[] {
  const signals: ExecSignal[] = [];
  for (const item of board.needsHuman) {
    const severity =
      item.urgency === "critical"
        ? "critical"
        : item.urgency === "high"
          ? "warning"
          : "watch";
    signals.push({
      key: `needs_human_${item.key}`,
      label: item.label,
      severity,
      detail: item.detail,
      source: item.source,
    });
  }
  for (const src of board.summary.unreadableSources) {
    signals.push({
      key: `unreadable_${src}`,
      label: `Queue unreadable: ${src}`,
      severity: "watch",
      detail: `The ${src} queue could not be read this cycle — "all clear" cannot be claimed for it.`,
      source: src,
    });
  }
  return signals;
}

const execAssistantExecHandler: TaskHandler = async () => {
  const board = await gatherExecutiveAssistantBoard();
  return summariseExecReview(
    {
      role: EXEC_ASSISTANT_EXEC_SLUG,
      roleLabel: "Executive Assistant",
      metrics: toExecMetrics(board.metrics),
      signals: buildExecAssistantSignals(board),
      sources: EXEC_ASSISTANT_EXEC_SOURCES,
    },
    new Date(),
  );
};

export async function enqueueExecAssistantReview(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveExecIdentity(EXEC_ASSISTANT_EXEC_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: EXEC_ASSISTANT_EXEC_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${EXEC_ASSISTANT_EXEC_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-executive-assistant-exec-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runExecAssistantReviewTask(): Promise<ExecRunOutcome> {
  const { identity } = await resolveExecIdentity(EXEC_ASSISTANT_EXEC_SLUG);
  registerTaskHandler(
    EXEC_ASSISTANT_EXEC_TASK_TYPE,
    identity,
    execAssistantExecHandler,
  );
  return normaliseExecOutcome(
    await runReadyTask(
      EXEC_ASSISTANT_EXEC_TASK_TYPE,
      execAssistantExecHandler,
      identity,
    ),
  );
}

export async function drainExecAssistantReviewTasks(
  limit = 2,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveExecIdentity(EXEC_ASSISTANT_EXEC_SLUG);
  registerTaskHandler(
    EXEC_ASSISTANT_EXEC_TASK_TYPE,
    identity,
    execAssistantExecHandler,
  );
  const summary = await drainTaskType(
    EXEC_ASSISTANT_EXEC_TASK_TYPE,
    execAssistantExecHandler,
    identity,
    { maxTasks: limit },
  );
  return { ok: true, ...summary };
}

export { EXEC_ASSISTANT_EXEC_SLUG, EXEC_ASSISTANT_EXEC_TASK_TYPE };
