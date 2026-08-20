import "server-only";

/**
 * CrewFlow HQ — CEO AI executive runner (exec execution path).
 *
 * Drains a `ceo_review` task off the generic Task Engine through the canonical runner
 * SDK and completes it with an explainable, company-wide review of the deterministic CEO
 * board (`getCeoDashboard`) — the five company vitals plus one scorecard per department.
 * Unlike the other exec boards the CEO board carries no uniform `metrics` array, so the
 * runner maps its vitals + department headlines to review metrics and its per-department
 * health tone to signals. Same engine surface as the roster runners (Reference Employee
 * Rule).
 *
 * DETERMINISTIC (no model), COMPUTES + REPORTS only, enqueue-only queue write.
 */

import { getCeoDashboard } from "@/server/services/hq-ceo";
import type { CeoBoard } from "@/lib/hq/ceo";
import {
  summariseExecReview,
  type ExecSignal,
  type ExecMetricInput,
} from "@/lib/hq/exec-runners";
import {
  resolveExecIdentity,
  normaliseExecOutcome,
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

const CEO_EXEC_SLUG = "ceo-ai";
const CEO_EXEC_TASK_TYPE = "ceo_review";
const CEO_EXEC_SOURCES = [
  "organizations",
  "billing_invoices",
  "hq_sales_companies",
  "support_tickets",
  "ai_employees",
];

/** Map the CEO board's vitals + department headlines into review metrics. */
function buildCeoMetrics(board: CeoBoard): ExecMetricInput[] {
  const metrics: ExecMetricInput[] = [];
  for (const v of board.vitals) {
    metrics.push({
      key: `vital_${v.key}`,
      label: v.label,
      kind: v.foundation ? "insufficient" : "fact",
      value: v.value,
      basis: v.foundation
        ? "No live data source wired yet (foundation)."
        : undefined,
    });
  }
  for (const d of board.departments) {
    metrics.push({
      key: `dept_${d.key}`,
      label: `${d.title}: ${d.headline.label}`,
      kind: d.headline.value == null ? "insufficient" : "fact",
      value: d.headline.value,
      basis:
        d.headline.value == null
          ? "Department headline could not be read this cycle."
          : undefined,
    });
  }
  return metrics;
}

/** Map each department's honest health tone into a signal. */
function buildCeoSignals(board: CeoBoard): ExecSignal[] {
  const signals: ExecSignal[] = [];
  for (const d of board.departments) {
    if (d.health.tone === "attention") {
      signals.push({
        key: `dept_attention_${d.key}`,
        label: `${d.title} needs attention`,
        severity: "warning",
        detail: `${d.title}: ${d.health.label}.`,
        source: d.title,
      });
    } else if (d.health.tone === "insufficient") {
      signals.push({
        key: `dept_unavailable_${d.key}`,
        label: `${d.title} health unavailable`,
        severity: "watch",
        detail: `${d.title} health could not be read this cycle — no claim can be made.`,
        source: d.title,
      });
    }
  }
  return signals;
}

const ceoExecHandler: TaskHandler = async () => {
  const { board } = await getCeoDashboard();
  return summariseExecReview(
    {
      role: CEO_EXEC_SLUG,
      roleLabel: "CEO",
      metrics: buildCeoMetrics(board),
      signals: buildCeoSignals(board),
      sources: CEO_EXEC_SOURCES,
    },
    new Date(),
  );
};

export async function enqueueCeoReview(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveExecIdentity(CEO_EXEC_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: CEO_EXEC_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${CEO_EXEC_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-ceo-exec-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runCeoReviewTask(): Promise<ExecRunOutcome> {
  const { identity } = await resolveExecIdentity(CEO_EXEC_SLUG);
  registerTaskHandler(CEO_EXEC_TASK_TYPE, identity, ceoExecHandler);
  return normaliseExecOutcome(
    await runReadyTask(CEO_EXEC_TASK_TYPE, ceoExecHandler, identity),
  );
}

export async function drainCeoReviewTasks(
  limit = 2,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveExecIdentity(CEO_EXEC_SLUG);
  registerTaskHandler(CEO_EXEC_TASK_TYPE, identity, ceoExecHandler);
  const summary = await drainTaskType(CEO_EXEC_TASK_TYPE, ceoExecHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

export { CEO_EXEC_SLUG, CEO_EXEC_TASK_TYPE };
