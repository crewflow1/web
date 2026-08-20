import "server-only";

/**
 * CrewFlow HQ — Design AI runner (HQ roster completion).
 *
 * Gives the previously-dark `design-ai` roster identity REAL deterministic work: a
 * brand-token consistency audit over the roster, run as a Task-Engine task. It owns NO
 * tables — it drains a `design_consistency` task off the generic Task Engine through the
 * canonical runner SDK (server/sdk/tasks.ts).
 *
 * Honesty + safety:
 *   • DETERMINISTIC — a brand-token scan of ai_employees.icon/accent. NO LLM.
 *   • It REPORTS, it does not act: it alters no shipped design.
 *   • Reads are SELECT-only and bounded; the only queue write is the sanctioned enqueue.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { summariseDesignConsistency, type DesignEmployeeRow } from "@/lib/hq/roster-workers";
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

const DESIGN_AI_SLUG = "design-ai";
const DESIGN_TASK_TYPE = "design_consistency";

const EMPLOYEE_WINDOW = 200;

async function readSignals(): Promise<{ employees: DesignEmployeeRow[] }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("ai_employees" as never)
    .select("slug, icon, accent")
    .order("sort_order", { ascending: true })
    .limit(EMPLOYEE_WINDOW);
  if (error) throw new Error(`hq-design-runner: employee read failed — ${error.message}`);
  return { employees: (data ?? []) as unknown as DesignEmployeeRow[] };
}

const designHandler: TaskHandler = async () => {
  const { employees } = await readSignals();
  return summariseDesignConsistency(employees, new Date());
};

export async function enqueueDesignConsistency(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveWorkerIdentity(DESIGN_AI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: DESIGN_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${DESIGN_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-design-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runDesignTask(): Promise<WorkerRunOutcome> {
  const { identity } = await resolveWorkerIdentity(DESIGN_AI_SLUG);
  registerTaskHandler(DESIGN_TASK_TYPE, identity, designHandler);
  return normaliseWorkerOutcome(await runReadyTask(DESIGN_TASK_TYPE, designHandler, identity));
}

export async function drainDesignTasks(limit = 1): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveWorkerIdentity(DESIGN_AI_SLUG);
  registerTaskHandler(DESIGN_TASK_TYPE, identity, designHandler);
  const summary = await drainTaskType(DESIGN_TASK_TYPE, designHandler, identity, { maxTasks: limit });
  return { ok: true, ...summary };
}

export { DESIGN_AI_SLUG, DESIGN_TASK_TYPE };
