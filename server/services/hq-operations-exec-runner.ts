import "server-only";

/**
 * CrewFlow HQ — Operations AI executive runner (exec execution path).
 *
 * Drains an `operations_review` task off the generic Task Engine through the canonical
 * runner SDK and completes it with an explainable review of the deterministic
 * Operations board (`gatherOperationsBoard`). Findings are read straight from the
 * board's own signals — the /admin/ops system-health traffic light and the open-alert
 * load by severity. Same engine surface as the roster runners (Reference Employee Rule).
 *
 * DETERMINISTIC (no model), COMPUTES + REPORTS only, enqueue-only queue write.
 * `buildOperationsSignals` is exported so the COO runner reviews the SAME operations
 * board without duplicating the extraction.
 */

import { gatherOperationsBoard } from "@/server/services/hq-operations";
import type { OperationsBoard } from "@/lib/hq/operations";
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

const OPERATIONS_EXEC_SLUG = "operations-ai";
const OPERATIONS_EXEC_TASK_TYPE = "operations_review";
export const OPERATIONS_EXEC_SOURCES = ["cron_runs", "admin_alert_state", "hq_ai_tasks"];

/** Extract the Operations board's concerning signals — read-only field access. */
export function buildOperationsSignals(board: OperationsBoard): ExecSignal[] {
  const signals: ExecSignal[] = [];
  if (board.systemHealth) {
    const reasons = board.systemHealth.reasons.join("; ");
    if (board.systemHealth.status === "red") {
      signals.push({
        key: "system_red",
        label: "System health degraded",
        severity: "critical",
        detail: reasons || board.systemHealth.summary || "System health is red.",
        source: "cron_runs",
      });
    } else if (board.systemHealth.status === "amber") {
      signals.push({
        key: "system_amber",
        label: "System health warning",
        severity: "warning",
        detail: reasons || board.systemHealth.summary || "System health is amber.",
        source: "cron_runs",
      });
    }
  }
  if (board.alertLoad) {
    if (board.alertLoad.critical > 0) {
      signals.push({
        key: "alerts_critical",
        label: "Critical alerts open",
        severity: "critical",
        detail: `${board.alertLoad.critical} critical alert(s) open${
          board.alertLoad.oldestAgeDays != null
            ? `, oldest ${board.alertLoad.oldestAgeDays}d`
            : ""
        }.`,
        source: "admin_alert_state",
      });
    }
    if (board.alertLoad.warning > 0) {
      signals.push({
        key: "alerts_warning",
        label: "Warning alerts open",
        severity: "warning",
        detail: `${board.alertLoad.warning} warning alert(s) open.`,
        source: "admin_alert_state",
      });
    }
  }
  return signals;
}

const operationsExecHandler: TaskHandler = async () => {
  const board = await gatherOperationsBoard();
  return summariseExecReview(
    {
      role: OPERATIONS_EXEC_SLUG,
      roleLabel: "Operations",
      metrics: toExecMetrics(board.metrics),
      signals: buildOperationsSignals(board),
      sources: OPERATIONS_EXEC_SOURCES,
    },
    new Date(),
  );
};

export async function enqueueOperationsReview(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveExecIdentity(OPERATIONS_EXEC_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: OPERATIONS_EXEC_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${OPERATIONS_EXEC_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-operations-exec-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runOperationsReviewTask(): Promise<ExecRunOutcome> {
  const { identity } = await resolveExecIdentity(OPERATIONS_EXEC_SLUG);
  registerTaskHandler(OPERATIONS_EXEC_TASK_TYPE, identity, operationsExecHandler);
  return normaliseExecOutcome(
    await runReadyTask(OPERATIONS_EXEC_TASK_TYPE, operationsExecHandler, identity),
  );
}

export async function drainOperationsReviewTasks(
  limit = 2,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveExecIdentity(OPERATIONS_EXEC_SLUG);
  registerTaskHandler(OPERATIONS_EXEC_TASK_TYPE, identity, operationsExecHandler);
  const summary = await drainTaskType(
    OPERATIONS_EXEC_TASK_TYPE,
    operationsExecHandler,
    identity,
    { maxTasks: limit },
  );
  return { ok: true, ...summary };
}

export { OPERATIONS_EXEC_SLUG, OPERATIONS_EXEC_TASK_TYPE };
