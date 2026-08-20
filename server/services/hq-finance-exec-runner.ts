import "server-only";

/**
 * CrewFlow HQ — Finance AI executive runner (exec execution path).
 *
 * Gives the `finance-ai` executive a REAL execution path: it drains a `finance_review`
 * task off the generic Task Engine (hq_ai_tasks) through the canonical runner SDK,
 * folds the deterministic Finance board into an explainable, sourced REVIEW, and
 * completes the task with it. Same shape as the roster runners (hq-analytics-runner) —
 * indistinguishable on the engine (the Reference Employee Rule).
 *
 * Honesty + safety:
 *   • DETERMINISTIC — the review is a pure fold of `gatherFinanceBoard()` (the SAME
 *     board the super-admin console renders). NO model, no governor, no randomness.
 *   • COMPUTES + REPORTS only — every result carries `requiresHumanApproval: true` and
 *     `autonomousApply: false`. Nothing sends, commits, decides, or mutates.
 *   • The only Task-Engine write is the sanctioned `enqueueTask` entry point; the queue
 *     is otherwise read-only through the SDK.
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

const FINANCE_EXEC_SLUG = "finance-ai";
const FINANCE_EXEC_TASK_TYPE = "finance_review";
const FINANCE_EXEC_SOURCES = ["organizations", "billing_invoices"];

/**
 * Business logic (Rule 5): fold the finance board into the review. Finance carries no
 * red/amber status field, so its findings come from the board's own honest GAPS
 * (insufficient metrics — runway, gross margin, CAC — with no source wired yet).
 */
const financeExecHandler: TaskHandler = async () => {
  const board = await gatherFinanceBoard();
  return summariseExecReview(
    {
      role: FINANCE_EXEC_SLUG,
      roleLabel: "Finance",
      metrics: toExecMetrics(board.metrics),
      signals: [],
      sources: FINANCE_EXEC_SOURCES,
    },
    new Date(),
  );
};

/** Enqueue one review task, deduped per day. Attributed to the seeded employee. */
export async function enqueueFinanceReview(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveExecIdentity(FINANCE_EXEC_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: FINANCE_EXEC_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${FINANCE_EXEC_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-finance-exec-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

/** Claim-one-and-exit through the canonical runner. */
export async function runFinanceReviewTask(): Promise<ExecRunOutcome> {
  const { identity } = await resolveExecIdentity(FINANCE_EXEC_SLUG);
  registerTaskHandler(FINANCE_EXEC_TASK_TYPE, identity, financeExecHandler);
  return normaliseExecOutcome(
    await runReadyTask(FINANCE_EXEC_TASK_TYPE, financeExecHandler, identity),
  );
}

/** Cron entry point: drain ready review tasks through the canonical runner. */
export async function drainFinanceReviewTasks(
  limit = 2,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveExecIdentity(FINANCE_EXEC_SLUG);
  registerTaskHandler(FINANCE_EXEC_TASK_TYPE, identity, financeExecHandler);
  const summary = await drainTaskType(
    FINANCE_EXEC_TASK_TYPE,
    financeExecHandler,
    identity,
    { maxTasks: limit },
  );
  return { ok: true, ...summary };
}

export { FINANCE_EXEC_SLUG, FINANCE_EXEC_TASK_TYPE };
