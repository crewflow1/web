import "server-only";

/**
 * CrewFlow HQ — Analytics AI runner (MP Wave R3).
 *
 * Gives the previously-dark `analytics-ai` roster identity REAL deterministic work: it
 * recomputes the HQ analytics snapshot as a Task-Engine task. It owns NO tables of its
 * own — it drains an `analytics_snapshot` task off the generic Task Engine (hq_ai_tasks)
 * through the canonical runner SDK (server/sdk/tasks.ts), which claims the task, holds a
 * time-boxed lease, and decides the terminal transition off the handler's return/throw.
 *
 * Honesty + safety:
 *   • DETERMINISTIC, not a model sample — the figures come from the existing analytics
 *     derivations (lib/hq/analytics.ts) over the real estate (organizations +
 *     billing_invoices). There is NO LLM in this path.
 *   • It COMPUTES and REPORTS only. No send, no commit, no mutation, no money moved. The
 *     result is persisted to the task's `result` jsonb the Boardroom already reads.
 *   • Honest "insufficient" when there is no estate to analyse — it never reports £0 as a
 *     finding conjured from absent data (lib/hq/roster-runners.ts).
 *   • Idempotent: enqueue is deduped per period; the engine claims atomically, so a
 *     double-kick (cron + cron) is harmless. Crash recovery is the engine's (lease +
 *     task-reaper).
 */

import { buildAnalyticsSnapshot } from "@/server/services/hq-analytics-snapshot";
import {
  computeRevenueAnalytics,
  computeCustomerAnalytics,
} from "@/lib/hq/analytics";
import { summariseAnalytics } from "@/lib/hq/roster-runners";
import { resolveRunnerIdentity } from "@/server/services/hq-runner-identity";
import { enqueueTask } from "@/server/services/hq-tasks";
import {
  drainTaskType,
  registerTaskHandler,
  runReadyTask,
  type DrainSummary,
  type EmployeeIdentity,
  type TaskHandler,
} from "@/server/sdk/tasks";

const ANALYTICS_AI_SLUG = "analytics-ai";
const ANALYTICS_TASK_TYPE = "analytics_snapshot";

/** Resolve the runtime identity, cached per module load. */
let cachedIdentity: EmployeeIdentity | undefined;
let cachedEmployeeId: string | null | undefined;

async function analyticsIdentity(): Promise<{
  identity: EmployeeIdentity;
  employeeId: string | null;
}> {
  if (cachedIdentity !== undefined) {
    return { identity: cachedIdentity, employeeId: cachedEmployeeId ?? null };
  }
  const resolved = await resolveRunnerIdentity(ANALYTICS_AI_SLUG);
  cachedIdentity = resolved.identity;
  cachedEmployeeId = resolved.employeeId;
  return resolved;
}

/**
 * The `analytics_snapshot` business logic (Rule 5: business logic ONLY). The runner owns
 * the lifecycle; this recomputes the snapshot, folds it through the deterministic
 * derivations, and returns the explainable envelope — which the runner completes the
 * task with.
 */
const analyticsTaskHandler: TaskHandler = async () => {
  const snapshot = await buildAnalyticsSnapshot();
  const revenue = computeRevenueAnalytics(snapshot);
  const customer = computeCustomerAnalytics(snapshot);
  const result = summariseAnalytics(
    {
      revenue,
      customer,
      orgCount: snapshot.orgs.length,
      invoiceCount: snapshot.invoices.length,
    },
    new Date(),
  );
  return result;
};

/**
 * Enqueue one snapshot task, deduped to the current day so repeated ticks never pile up
 * a backlog. Attributes the task to the seeded employee (so the Boardroom cards light
 * up); when the identity was never seeded there is no UUID to attribute to and we skip.
 */
export async function enqueueAnalyticsSnapshot(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await analyticsIdentity();
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: ANALYTICS_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${ANALYTICS_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-analytics-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

/** Claim-one-and-exit: run the next ready snapshot task through the canonical runner. */
export async function runAnalyticsTask(): Promise<RunOutcomeSummary> {
  const { identity } = await analyticsIdentity();
  registerTaskHandler(ANALYTICS_TASK_TYPE, identity, analyticsTaskHandler);
  const o = await runReadyTask(ANALYTICS_TASK_TYPE, analyticsTaskHandler, identity);
  return normaliseOutcome(o);
}

/** Cron entry point: drain ready snapshot tasks through the canonical runner. */
export async function drainAnalyticsTasks(limit = 2): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await analyticsIdentity();
  registerTaskHandler(ANALYTICS_TASK_TYPE, identity, analyticsTaskHandler);
  const summary = await drainTaskType(ANALYTICS_TASK_TYPE, analyticsTaskHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

export type RunOutcomeSummary =
  | { ok: true; status: "completed" | "skipped"; taskId?: string }
  | { ok: false; status: "failed"; taskId?: string; error: string };

function normaliseOutcome(o: Awaited<ReturnType<typeof runReadyTask>>): RunOutcomeSummary {
  switch (o.status) {
    case "completed":
      return { ok: true, status: "completed", taskId: o.taskId };
    case "empty":
      return { ok: true, status: "skipped" };
    case "failed":
      return { ok: false, status: "failed", taskId: o.taskId, error: o.error };
    case "lease_lost":
      return { ok: false, status: "failed", taskId: o.taskId, error: "lease lost (reaped or re-claimed)" };
    case "error":
      return { ok: false, status: "failed", error: o.error };
  }
}

export { ANALYTICS_AI_SLUG, ANALYTICS_TASK_TYPE };
