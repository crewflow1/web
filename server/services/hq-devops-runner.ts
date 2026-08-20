import "server-only";

/**
 * CrewFlow HQ — DevOps AI runner (HQ roster completion).
 *
 * Gives the previously-dark `devops-ai` roster identity REAL deterministic work: a
 * deploy/pipeline-health read over cron + AI-schedule telemetry, run as a Task-Engine
 * task. It owns NO tables — it drains a `devops_health` task off the generic Task Engine
 * through the canonical runner SDK (server/sdk/tasks.ts).
 *
 * Honesty + safety:
 *   • DETERMINISTIC — every signal is a read of a real column (cron_runs.ok,
 *     hq_ai_schedule_runs.outcome). NO LLM.
 *   • It REPORTS, it does not act: it triggers no deploy and touches no environment.
 *   • Reads are SELECT-only and bounded; the only queue write is the sanctioned enqueue.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import {
  summariseDeployHealth,
  type DevopsCronRow,
  type DevopsScheduleRow,
} from "@/lib/hq/roster-workers";
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

const DEVOPS_AI_SLUG = "devops-ai";
const DEVOPS_TASK_TYPE = "devops_health";

const CRON_WINDOW = 300;
const SCHEDULE_WINDOW = 300;

async function readSignals(): Promise<{
  cronRuns: DevopsCronRow[];
  scheduleRuns: DevopsScheduleRow[];
}> {
  const admin = createAdminClient();

  const { data: cronData, error: cronErr } = await admin
    .from("cron_runs" as never)
    .select("route, ok")
    .order("started_at", { ascending: false })
    .limit(CRON_WINDOW);
  if (cronErr) throw new Error(`hq-devops-runner: cron read failed — ${cronErr.message}`);

  const { data: schedData, error: schedErr } = await admin
    .from("hq_ai_schedule_runs" as never)
    .select("outcome")
    .order("fired_at", { ascending: false })
    .limit(SCHEDULE_WINDOW);
  if (schedErr) throw new Error(`hq-devops-runner: schedule read failed — ${schedErr.message}`);

  return {
    cronRuns: (cronData ?? []) as unknown as DevopsCronRow[],
    scheduleRuns: (schedData ?? []) as unknown as DevopsScheduleRow[],
  };
}

const devopsHandler: TaskHandler = async () => {
  const { cronRuns, scheduleRuns } = await readSignals();
  return summariseDeployHealth(cronRuns, scheduleRuns, new Date());
};

export async function enqueueDevopsHealth(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveWorkerIdentity(DEVOPS_AI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: DEVOPS_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${DEVOPS_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-devops-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runDevopsTask(): Promise<WorkerRunOutcome> {
  const { identity } = await resolveWorkerIdentity(DEVOPS_AI_SLUG);
  registerTaskHandler(DEVOPS_TASK_TYPE, identity, devopsHandler);
  return normaliseWorkerOutcome(await runReadyTask(DEVOPS_TASK_TYPE, devopsHandler, identity));
}

export async function drainDevopsTasks(limit = 1): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveWorkerIdentity(DEVOPS_AI_SLUG);
  registerTaskHandler(DEVOPS_TASK_TYPE, identity, devopsHandler);
  const summary = await drainTaskType(DEVOPS_TASK_TYPE, devopsHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

export { DEVOPS_AI_SLUG, DEVOPS_TASK_TYPE };
