import "server-only";

/**
 * CrewFlow HQ — Monitoring & Incident AI runner (MP Wave R3).
 *
 * Gives the previously-dark `monitoring-incident-ai` roster identity REAL deterministic
 * work: it sweeps the Task Engine + cron telemetry into a single incident picture as a
 * Task-Engine task. It owns NO tables — it drains a `monitoring_sweep` task off the
 * generic Task Engine (hq_ai_tasks) through the canonical runner SDK (server/sdk/tasks.ts).
 *
 * Honesty + safety:
 *   • DETERMINISTIC — every signal is a read of a real column (lease_expires_at,
 *     heartbeat_at, retry_count, cron_runs.ok). NO LLM.
 *   • It REPORTS, it does not resolve: the reaper cron owns lease recovery; this runner
 *     only assembles the picture. No side effect, no mutation.
 *   • The hq_ai_tasks read is the SAME sanctioned read the Boardroom uses
 *     (hq-task-pipeline) — a SELECT only. The runner NEVER raw-writes the queue; the only
 *     write path stays the SECURITY DEFINER entry points.
 *   • Honest "insufficient" when there is nothing to observe (no tasks and no cron runs).
 */

import { createAdminClient } from "@/lib/supabase/admin";
import {
  summariseMonitoring,
  type MonitoringTaskRow,
  type MonitoringCronRow,
} from "@/lib/hq/roster-runners";
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

const MONITORING_AI_SLUG = "monitoring-incident-ai";
const MONITORING_TASK_TYPE = "monitoring_sweep";

/** Bounded windows — enough to catch live incidents, cheap to read. */
const TASK_WINDOW = 500;
const CRON_WINDOW = 200;

let cachedIdentity: EmployeeIdentity | undefined;
let cachedEmployeeId: string | null | undefined;

async function monitoringIdentity(): Promise<{
  identity: EmployeeIdentity;
  employeeId: string | null;
}> {
  if (cachedIdentity !== undefined) {
    return { identity: cachedIdentity, employeeId: cachedEmployeeId ?? null };
  }
  const resolved = await resolveRunnerIdentity(MONITORING_AI_SLUG);
  cachedIdentity = resolved.identity;
  cachedEmployeeId = resolved.employeeId;
  return resolved;
}

/**
 * Read the recent task + cron windows (SELECT only — never a write to the queue) and
 * defer to the pure sweep derivation.
 */
async function readSignals(): Promise<{
  tasks: MonitoringTaskRow[];
  cronRuns: MonitoringCronRow[];
}> {
  const admin = createAdminClient();

  const { data: taskData, error: taskErr } = await admin
    .from("hq_ai_tasks" as never)
    .select("status, lease_expires_at, heartbeat_at, retry_count, max_retries, updated_at")
    .order("created_at", { ascending: false })
    .limit(TASK_WINDOW);
  if (taskErr) {
    throw new Error(`hq-monitoring-runner: task read failed — ${taskErr.message}`);
  }

  const { data: cronData, error: cronErr } = await admin
    .from("cron_runs" as never)
    .select("route, ok, completed_at")
    .order("started_at", { ascending: false })
    .limit(CRON_WINDOW);
  if (cronErr) {
    throw new Error(`hq-monitoring-runner: cron read failed — ${cronErr.message}`);
  }

  return {
    tasks: (taskData ?? []) as unknown as MonitoringTaskRow[],
    cronRuns: (cronData ?? []) as unknown as MonitoringCronRow[],
  };
}

const monitoringTaskHandler: TaskHandler = async () => {
  const { tasks, cronRuns } = await readSignals();
  return summariseMonitoring(tasks, cronRuns, new Date());
};

/** Enqueue one sweep task, deduped to the current hour (health is a fast-moving signal). */
export async function enqueueMonitoringSweep(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await monitoringIdentity();
  if (!employeeId) return { ok: true, skipped: true };
  const hour = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
  const enq = await enqueueTask({
    taskType: MONITORING_TASK_TYPE,
    priority: "normal",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${MONITORING_TASK_TYPE}:${hour}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-monitoring-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

/** Claim-one-and-exit: run the next ready sweep task through the canonical runner. */
export async function runMonitoringTask(): Promise<RunOutcomeSummary> {
  const { identity } = await monitoringIdentity();
  registerTaskHandler(MONITORING_TASK_TYPE, identity, monitoringTaskHandler);
  const o = await runReadyTask(MONITORING_TASK_TYPE, monitoringTaskHandler, identity);
  return normaliseOutcome(o);
}

/** Cron entry point: drain ready sweep tasks through the canonical runner. */
export async function drainMonitoringTasks(limit = 2): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await monitoringIdentity();
  registerTaskHandler(MONITORING_TASK_TYPE, identity, monitoringTaskHandler);
  const summary = await drainTaskType(MONITORING_TASK_TYPE, monitoringTaskHandler, identity, {
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

export { MONITORING_AI_SLUG, MONITORING_TASK_TYPE };
