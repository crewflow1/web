import "server-only";

/**
 * CrewFlow HQ — People & HR AI runner (HQ roster completion).
 *
 * Gives the previously-dark `hr-ai` roster identity REAL deterministic work: a workforce
 * coherence read over the roster + registry, run as a Task-Engine task. It owns NO tables
 * — it drains a `workforce_review` task off the generic Task Engine through the canonical
 * runner SDK (server/sdk/tasks.ts).
 *
 * Honesty + safety:
 *   • DETERMINISTIC — a coherence read of ai_employees against employee-scoped
 *     hq_capability_grants (an employee with no grant is a backfill gap). NO LLM.
 *   • It REPORTS, it does not act: it holds no authority over any person record.
 *   • Reads are SELECT-only and bounded; the only queue write is the sanctioned enqueue.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { summariseWorkforce, type HrEmployeeRow } from "@/lib/hq/roster-workers";
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

const HR_AI_SLUG = "hr-ai";
const HR_TASK_TYPE = "workforce_review";

const EMPLOYEE_WINDOW = 200;
const GRANT_WINDOW = 1000;

async function readSignals(): Promise<{
  employees: HrEmployeeRow[];
  grantedSlugs: string[];
}> {
  const admin = createAdminClient();

  const { data: empData, error: empErr } = await admin
    .from("ai_employees" as never)
    .select("slug, department, status")
    .order("sort_order", { ascending: true })
    .limit(EMPLOYEE_WINDOW);
  if (empErr) throw new Error(`hq-hr-runner: employee read failed — ${empErr.message}`);

  const { data: grantData, error: grantErr } = await admin
    .from("hq_capability_grants" as never)
    .select("scope_key")
    .eq("scope_level", "employee")
    .order("created_at", { ascending: false })
    .limit(GRANT_WINDOW);
  if (grantErr) throw new Error(`hq-hr-runner: grant read failed — ${grantErr.message}`);

  const grantedSlugs = ((grantData ?? []) as unknown as Array<{ scope_key: string | null }>)
    .map((r) => r.scope_key)
    .filter((v): v is string => typeof v === "string" && v.length > 0);

  return {
    employees: (empData ?? []) as unknown as HrEmployeeRow[],
    grantedSlugs,
  };
}

const hrHandler: TaskHandler = async () => {
  const { employees, grantedSlugs } = await readSignals();
  return summariseWorkforce(employees, grantedSlugs, new Date());
};

export async function enqueueWorkforceReview(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveWorkerIdentity(HR_AI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: HR_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${HR_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-hr-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runWorkforceTask(): Promise<WorkerRunOutcome> {
  const { identity } = await resolveWorkerIdentity(HR_AI_SLUG);
  registerTaskHandler(HR_TASK_TYPE, identity, hrHandler);
  return normaliseWorkerOutcome(await runReadyTask(HR_TASK_TYPE, hrHandler, identity));
}

export async function drainWorkforceTasks(limit = 1): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveWorkerIdentity(HR_AI_SLUG);
  registerTaskHandler(HR_TASK_TYPE, identity, hrHandler);
  const summary = await drainTaskType(HR_TASK_TYPE, hrHandler, identity, { maxTasks: limit });
  return { ok: true, ...summary };
}

export { HR_AI_SLUG, HR_TASK_TYPE };
