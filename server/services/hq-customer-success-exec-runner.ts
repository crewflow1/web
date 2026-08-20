import "server-only";

/**
 * CrewFlow HQ — Customer-Success AI executive runner (exec execution path).
 *
 * Drains a `customer_success_review` task off the generic Task Engine through the
 * canonical runner SDK and completes it with an explainable review of the deterministic
 * Customer-Success board (`gatherCustomerSuccessBoard`). Findings are read straight from
 * the customer-health distribution — critical / at-risk / unscored accounts. Same engine
 * surface as the roster runners (Reference Employee Rule).
 *
 * DETERMINISTIC (no model), COMPUTES + REPORTS only, enqueue-only queue write.
 */

import { gatherCustomerSuccessBoard } from "@/server/services/hq-customer-success";
import type { CustomerSuccessBoard } from "@/lib/hq/customer-success";
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

const CUSTOMER_SUCCESS_EXEC_SLUG = "customer-success-ai";
const CUSTOMER_SUCCESS_EXEC_TASK_TYPE = "customer_success_review";
const CUSTOMER_SUCCESS_EXEC_SOURCES = ["organizations", "demo_requests"];

function buildCustomerSuccessSignals(board: CustomerSuccessBoard): ExecSignal[] {
  const signals: ExecSignal[] = [];
  if (!board.healthSegments) return signals;
  for (const seg of board.healthSegments) {
    if (seg.value <= 0) continue;
    if (seg.key === "critical") {
      signals.push({
        key: "health_critical",
        label: "Accounts in critical health",
        severity: "critical",
        detail: `${seg.value} paying/trial account(s) in the critical health band.`,
        source: "organizations",
      });
    } else if (seg.key === "at_risk" || seg.key === "atRisk") {
      signals.push({
        key: "health_at_risk",
        label: "Accounts at risk",
        severity: "warning",
        detail: `${seg.value} paying/trial account(s) in the at-risk health band.`,
        source: "organizations",
      });
    } else if (seg.key === "unscored") {
      signals.push({
        key: "health_unscored",
        label: "Accounts with no health score",
        severity: "watch",
        detail: `${seg.value} paying/trial account(s) have no health score yet.`,
        source: "organizations",
      });
    }
  }
  return signals;
}

const customerSuccessExecHandler: TaskHandler = async () => {
  const board = await gatherCustomerSuccessBoard();
  return summariseExecReview(
    {
      role: CUSTOMER_SUCCESS_EXEC_SLUG,
      roleLabel: "Customer Success",
      metrics: toExecMetrics(board.metrics),
      signals: buildCustomerSuccessSignals(board),
      sources: CUSTOMER_SUCCESS_EXEC_SOURCES,
    },
    new Date(),
  );
};

export async function enqueueCustomerSuccessReview(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveExecIdentity(CUSTOMER_SUCCESS_EXEC_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: CUSTOMER_SUCCESS_EXEC_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${CUSTOMER_SUCCESS_EXEC_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-customer-success-exec-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runCustomerSuccessReviewTask(): Promise<ExecRunOutcome> {
  const { identity } = await resolveExecIdentity(CUSTOMER_SUCCESS_EXEC_SLUG);
  registerTaskHandler(
    CUSTOMER_SUCCESS_EXEC_TASK_TYPE,
    identity,
    customerSuccessExecHandler,
  );
  return normaliseExecOutcome(
    await runReadyTask(
      CUSTOMER_SUCCESS_EXEC_TASK_TYPE,
      customerSuccessExecHandler,
      identity,
    ),
  );
}

export async function drainCustomerSuccessReviewTasks(
  limit = 2,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveExecIdentity(CUSTOMER_SUCCESS_EXEC_SLUG);
  registerTaskHandler(
    CUSTOMER_SUCCESS_EXEC_TASK_TYPE,
    identity,
    customerSuccessExecHandler,
  );
  const summary = await drainTaskType(
    CUSTOMER_SUCCESS_EXEC_TASK_TYPE,
    customerSuccessExecHandler,
    identity,
    { maxTasks: limit },
  );
  return { ok: true, ...summary };
}

export { CUSTOMER_SUCCESS_EXEC_SLUG, CUSTOMER_SUCCESS_EXEC_TASK_TYPE };
