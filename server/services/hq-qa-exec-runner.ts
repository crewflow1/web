import "server-only";

/**
 * CrewFlow HQ — QA AI executive runner (exec execution path).
 *
 * Drains a `qa_review` task off the generic Task Engine through the canonical runner SDK
 * and completes it with an explainable review of the deterministic QA board
 * (`gatherQaBoard`). Findings are read straight from the board's own signals —
 * task-engine reliability health and the AI-reply guardrail verdict split (blocked /
 * held). Same engine surface as the roster runners (Reference Employee Rule).
 *
 * DETERMINISTIC (no model), COMPUTES + REPORTS only, enqueue-only queue write.
 */

import { gatherQaBoard } from "@/server/services/hq-qa";
import type { QaBoard } from "@/lib/hq/qa";
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

const QA_EXEC_SLUG = "qa-ai";
const QA_EXEC_TASK_TYPE = "qa_review";
const QA_EXEC_SOURCES = ["hq_ai_tasks", "ai_reply_audits", "executor_shadow_observations"];

function buildQaSignals(board: QaBoard): ExecSignal[] {
  const signals: ExecSignal[] = [];
  if (board.reliabilityHealth) {
    const lvl = board.reliabilityHealth.level;
    const reasons = board.reliabilityHealth.reasons.join("; ");
    if (lvl === "red") {
      signals.push({
        key: "reliability_red",
        label: "Task-engine reliability degraded",
        severity: "critical",
        detail: reasons || "Task-engine reliability is red.",
        source: "hq_ai_tasks",
      });
    } else if (lvl === "amber") {
      signals.push({
        key: "reliability_amber",
        label: "Task-engine reliability warning",
        severity: "warning",
        detail: reasons || "Task-engine reliability is amber.",
        source: "hq_ai_tasks",
      });
    }
  }
  if (board.replyQuality) {
    if (board.replyQuality.block > 0) {
      signals.push({
        key: "reply_blocked",
        label: "AI replies blocked by the guardrail",
        severity: "warning",
        detail: `${board.replyQuality.block} of ${board.replyQuality.total} audited replies were refused by the guardrail.`,
        source: "ai_reply_audits",
      });
    }
    if (board.replyQuality.review > 0) {
      signals.push({
        key: "reply_held",
        label: "AI replies held for human review",
        severity: "watch",
        detail: `${board.replyQuality.review} of ${board.replyQuality.total} audited replies were escalated for review.`,
        source: "ai_reply_audits",
      });
    }
  }
  return signals;
}

const qaExecHandler: TaskHandler = async () => {
  const board = await gatherQaBoard();
  return summariseExecReview(
    {
      role: QA_EXEC_SLUG,
      roleLabel: "QA",
      metrics: toExecMetrics(board.metrics),
      signals: buildQaSignals(board),
      sources: QA_EXEC_SOURCES,
    },
    new Date(),
  );
};

export async function enqueueQaReview(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveExecIdentity(QA_EXEC_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: QA_EXEC_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${QA_EXEC_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-qa-exec-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runQaReviewTask(): Promise<ExecRunOutcome> {
  const { identity } = await resolveExecIdentity(QA_EXEC_SLUG);
  registerTaskHandler(QA_EXEC_TASK_TYPE, identity, qaExecHandler);
  return normaliseExecOutcome(
    await runReadyTask(QA_EXEC_TASK_TYPE, qaExecHandler, identity),
  );
}

export async function drainQaReviewTasks(
  limit = 2,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveExecIdentity(QA_EXEC_SLUG);
  registerTaskHandler(QA_EXEC_TASK_TYPE, identity, qaExecHandler);
  const summary = await drainTaskType(QA_EXEC_TASK_TYPE, qaExecHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

export { QA_EXEC_SLUG, QA_EXEC_TASK_TYPE };
