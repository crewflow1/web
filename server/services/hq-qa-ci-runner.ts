import "server-only";

/**
 * CrewFlow HQ — QA AI CI-snapshot runner (R092, P9 residual).
 *
 * Gives the QA AI its first real CI signal as a Task-Engine task: a daily
 * `qa_ci_snapshot` task asks the DARK GitHub adapter for recent workflow runs
 * and completes with the deterministic fold (`litCiSnapshot`, lib/hq/qa-ci.ts).
 * It owns NO tables and adds NO migrations — the task RESULT row is the record
 * (the QA board's regression-pass-rate cards stay honestly `insufficient`
 * until a schema source exists; latest completed `qa_ci_snapshot` results are
 * readable from the queue whenever a surface wants them). The canonical runner
 * SDK (server/sdk/tasks.ts) drives the lifecycle, exactly like every other
 * employee (the Reference Employee Rule).
 *
 * Honesty + safety (mirrors server/services/hq-cto-review-runner.ts):
 *   • DETERMINISTIC — the snapshot is pure arithmetic over the fetched runs.
 *     NO LLM anywhere in this runner, and NO fabricated pass rates.
 *   • DARK UNTIL A TOKEN EXISTS — with no GITHUB_TOKEN/GITHUB_REPO the adapter
 *     refuses before fetch, and the task COMPLETES with the honest dark
 *     envelope ({ dark: true, reason, runs: null }). Dark is a completion,
 *     not a failure; supplying the credentials is the only activation switch.
 *   • Reads are ONE bounded adapter GET (per_page ≤ 100, no pagination loop);
 *     the only queue write is the sanctioned enqueue (enqueueTask), deduped
 *     per UTC day so a re-tick never piles up snapshots.
 */

import { GithubAdapter, githubNotConfigured } from "@/lib/integrations/github/adapter";
import { darkCiSnapshot, litCiSnapshot } from "@/lib/hq/qa-ci";
import { enqueueTask } from "@/server/services/hq-tasks";
import {
  resolveWorkerIdentity,
  normaliseWorkerOutcome,
  type WorkerRunOutcome,
} from "@/server/services/hq-worker-runner-kit";
import {
  drainTaskType,
  registerTaskHandler,
  runReadyTask,
  type DrainSummary,
  type TaskHandler,
} from "@/server/sdk/tasks";

const QA_CI_SLUG = "qa-ai";
const QA_CI_TASK_TYPE = "qa_ci_snapshot";

/** One bounded page of runs — a recent picture, never the archive. */
const QA_CI_RUN_WINDOW = 100;

/** The adapter's own stated refusal — reused verbatim as the dark reason. */
function adapterDarkReason(): string {
  const refusal = githubNotConfigured<never>();
  return refusal.ok ? "GitHub is not connected." : refusal.message;
}

const qaCiSnapshotHandler: TaskHandler = async () => {
  const adapter = new GithubAdapter();

  // DARK PATH — a completion, not a failure. No network is touched.
  if (!adapter.isAvailable()) {
    return darkCiSnapshot(adapterDarkReason(), new Date());
  }

  const runs = await adapter.listRecentWorkflowRuns(QA_CI_RUN_WINDOW);
  if (!runs.ok) {
    if (runs.reason === "not_configured") {
      return darkCiSnapshot(runs.message, new Date());
    }
    // unauthorized / transient errors are retryable — the engine re-queues.
    throw new Error(`qa_ci_snapshot: workflow-run fetch failed — ${runs.message}`);
  }

  return litCiSnapshot(runs.data, new Date());
};

export async function enqueueQaCiSnapshot(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveWorkerIdentity(QA_CI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: QA_CI_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${QA_CI_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-qa-ci-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runQaCiSnapshotTask(): Promise<WorkerRunOutcome> {
  const { identity } = await resolveWorkerIdentity(QA_CI_SLUG);
  registerTaskHandler(QA_CI_TASK_TYPE, identity, qaCiSnapshotHandler);
  return normaliseWorkerOutcome(
    await runReadyTask(QA_CI_TASK_TYPE, qaCiSnapshotHandler, identity),
  );
}

export async function drainQaCiSnapshotTasks(
  limit = 1,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveWorkerIdentity(QA_CI_SLUG);
  registerTaskHandler(QA_CI_TASK_TYPE, identity, qaCiSnapshotHandler);
  const summary = await drainTaskType(QA_CI_TASK_TYPE, qaCiSnapshotHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

export { QA_CI_SLUG, QA_CI_TASK_TYPE, qaCiSnapshotHandler };
