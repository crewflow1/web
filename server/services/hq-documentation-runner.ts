import "server-only";

/**
 * CrewFlow HQ — Documentation AI runner (HQ roster completion).
 *
 * Gives the previously-dark `documentation-ai` roster identity REAL deterministic work: a
 * doc-drift scan over the roster + capability catalogue descriptions, run as a Task-Engine
 * task. It owns NO tables — it drains a `documentation_drift` task off the generic Task
 * Engine through the canonical runner SDK (server/sdk/tasks.ts).
 *
 * Honesty + safety:
 *   • DETERMINISTIC — a blank-text scan over ai_employees.role/description and
 *     hq_capabilities.description. NO LLM (no prose is generated).
 *   • It REPORTS, it does not act: it edits no doc.
 *   • Reads are SELECT-only and bounded; the only queue write is the sanctioned enqueue.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import {
  summariseDocDrift,
  type DocEmployeeRow,
  type DocCatalogueRow,
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

const DOCUMENTATION_AI_SLUG = "documentation-ai";
const DOCUMENTATION_TASK_TYPE = "documentation_drift";

const EMPLOYEE_WINDOW = 200;
const CATALOGUE_WINDOW = 1000;

async function readSignals(): Promise<{
  employees: DocEmployeeRow[];
  catalogue: DocCatalogueRow[];
}> {
  const admin = createAdminClient();

  const { data: empData, error: empErr } = await admin
    .from("ai_employees" as never)
    .select("slug, role, description")
    .order("sort_order", { ascending: true })
    .limit(EMPLOYEE_WINDOW);
  if (empErr) throw new Error(`hq-documentation-runner: employee read failed — ${empErr.message}`);

  const { data: catData, error: catErr } = await admin
    .from("hq_capabilities" as never)
    .select("token, description")
    .order("token", { ascending: true })
    .limit(CATALOGUE_WINDOW);
  if (catErr) throw new Error(`hq-documentation-runner: catalogue read failed — ${catErr.message}`);

  return {
    employees: (empData ?? []) as unknown as DocEmployeeRow[],
    catalogue: (catData ?? []) as unknown as DocCatalogueRow[],
  };
}

const documentationHandler: TaskHandler = async () => {
  const { employees, catalogue } = await readSignals();
  return summariseDocDrift(employees, catalogue, new Date());
};

export async function enqueueDocumentationDrift(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveWorkerIdentity(DOCUMENTATION_AI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: DOCUMENTATION_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${DOCUMENTATION_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-documentation-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runDocumentationTask(): Promise<WorkerRunOutcome> {
  const { identity } = await resolveWorkerIdentity(DOCUMENTATION_AI_SLUG);
  registerTaskHandler(DOCUMENTATION_TASK_TYPE, identity, documentationHandler);
  return normaliseWorkerOutcome(
    await runReadyTask(DOCUMENTATION_TASK_TYPE, documentationHandler, identity),
  );
}

export async function drainDocumentationTasks(
  limit = 1,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveWorkerIdentity(DOCUMENTATION_AI_SLUG);
  registerTaskHandler(DOCUMENTATION_TASK_TYPE, identity, documentationHandler);
  const summary = await drainTaskType(DOCUMENTATION_TASK_TYPE, documentationHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

export { DOCUMENTATION_AI_SLUG, DOCUMENTATION_TASK_TYPE };
