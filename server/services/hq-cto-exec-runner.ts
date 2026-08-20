import "server-only";

/**
 * CrewFlow HQ — CTO AI executive runner (exec execution path).
 *
 * Drains a `cto_review` task off the generic Task Engine through the canonical runner
 * SDK and completes it with an explainable review of the deterministic CTO engineering
 * board (`gatherCtoBoard`). Findings are read straight from the board's own signals —
 * launch-readiness blockers/warnings and task-engine reliability health — each carrying
 * its source. Same engine surface as the roster runners (Reference Employee Rule).
 *
 * DETERMINISTIC (no model), COMPUTES + REPORTS only, enqueue-only queue write.
 */

import { gatherCtoBoard } from "@/server/services/hq-cto";
import type { CtoBoard } from "@/lib/hq/cto";
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

const CTO_EXEC_SLUG = "cto-ai";
const CTO_EXEC_TASK_TYPE = "cto_review";
const CTO_EXEC_SOURCES = [
  "launch_readiness",
  "hq_ai_tasks",
  "executor_shadow_observations",
];

/** Extract the CTO board's concerning signals — read-only field access, no logic drift. */
function buildCtoSignals(board: CtoBoard): ExecSignal[] {
  const signals: ExecSignal[] = [];
  if (board.launch) {
    if (board.launch.overall === "red") {
      signals.push({
        key: "launch_blockers",
        label: "Launch readiness: blockers open",
        severity: "critical",
        detail:
          board.launch.blockers.length > 0
            ? `${board.launch.blockers.length} blocker(s): ${board.launch.blockers.join(", ")}`
            : "Launch readiness is red.",
        source: "launch_readiness",
      });
    } else if (board.launch.overall === "amber") {
      signals.push({
        key: "launch_warnings",
        label: "Launch readiness: warnings",
        severity: "warning",
        detail:
          board.launch.warnings.length > 0
            ? `${board.launch.warnings.length} warning(s): ${board.launch.warnings.join(", ")}`
            : "Launch readiness is amber.",
        source: "launch_readiness",
      });
    }
  }
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
  return signals;
}

const ctoExecHandler: TaskHandler = async () => {
  const board = await gatherCtoBoard();
  return summariseExecReview(
    {
      role: CTO_EXEC_SLUG,
      roleLabel: "CTO",
      metrics: toExecMetrics(board.metrics),
      signals: buildCtoSignals(board),
      sources: CTO_EXEC_SOURCES,
    },
    new Date(),
  );
};

export async function enqueueCtoReview(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveExecIdentity(CTO_EXEC_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: CTO_EXEC_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${CTO_EXEC_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-cto-exec-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runCtoReviewTask(): Promise<ExecRunOutcome> {
  const { identity } = await resolveExecIdentity(CTO_EXEC_SLUG);
  registerTaskHandler(CTO_EXEC_TASK_TYPE, identity, ctoExecHandler);
  return normaliseExecOutcome(
    await runReadyTask(CTO_EXEC_TASK_TYPE, ctoExecHandler, identity),
  );
}

export async function drainCtoReviewTasks(
  limit = 2,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveExecIdentity(CTO_EXEC_SLUG);
  registerTaskHandler(CTO_EXEC_TASK_TYPE, identity, ctoExecHandler);
  const summary = await drainTaskType(CTO_EXEC_TASK_TYPE, ctoExecHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

export { CTO_EXEC_SLUG, CTO_EXEC_TASK_TYPE };
