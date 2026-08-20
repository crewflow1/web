import "server-only";

/**
 * CrewFlow HQ — API AI runner (HQ roster completion).
 *
 * Gives the previously-dark `api-ai` roster identity REAL deterministic work: a
 * capability-contract integrity read — every granted token reconciled against the
 * catalogue that defines it — run as a Task-Engine task. It owns NO tables — it drains an
 * `api_contract_health` task off the generic Task Engine through the canonical runner SDK
 * (server/sdk/tasks.ts).
 *
 * Honesty + safety:
 *   • DETERMINISTIC — a set reconciliation of hq_capability_grants.tokens against
 *     hq_capabilities.token. NO LLM.
 *   • It REPORTS, it does not act: it changes no endpoint and ships no breaking change.
 *   • Reads are SELECT-only and bounded; the only queue write is the sanctioned enqueue.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { summariseApiContract } from "@/lib/hq/roster-workers";
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

const API_AI_SLUG = "api-ai";
const API_TASK_TYPE = "api_contract_health";

const GRANT_WINDOW = 1000;
const CATALOGUE_WINDOW = 1000;

async function readSignals(): Promise<{
  grantedTokens: string[];
  catalogueTokens: string[];
}> {
  const admin = createAdminClient();

  const { data: grantData, error: grantErr } = await admin
    .from("hq_capability_grants" as never)
    .select("tokens")
    .order("created_at", { ascending: false })
    .limit(GRANT_WINDOW);
  if (grantErr) throw new Error(`hq-api-runner: grant read failed — ${grantErr.message}`);

  const { data: catData, error: catErr } = await admin
    .from("hq_capabilities" as never)
    .select("token")
    .order("token", { ascending: true })
    .limit(CATALOGUE_WINDOW);
  if (catErr) throw new Error(`hq-api-runner: catalogue read failed — ${catErr.message}`);

  const grantedTokens: string[] = [];
  for (const row of (grantData ?? []) as unknown as Array<{ tokens: string[] | null }>) {
    for (const t of row.tokens ?? []) grantedTokens.push(t);
  }
  const catalogueTokens = ((catData ?? []) as unknown as Array<{ token: string }>).map(
    (r) => r.token,
  );

  return { grantedTokens, catalogueTokens };
}

const apiHandler: TaskHandler = async () => {
  const { grantedTokens, catalogueTokens } = await readSignals();
  return summariseApiContract(grantedTokens, catalogueTokens, new Date());
};

export async function enqueueApiContract(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveWorkerIdentity(API_AI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: API_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${API_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-api-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runApiTask(): Promise<WorkerRunOutcome> {
  const { identity } = await resolveWorkerIdentity(API_AI_SLUG);
  registerTaskHandler(API_TASK_TYPE, identity, apiHandler);
  return normaliseWorkerOutcome(await runReadyTask(API_TASK_TYPE, apiHandler, identity));
}

export async function drainApiTasks(limit = 1): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveWorkerIdentity(API_AI_SLUG);
  registerTaskHandler(API_TASK_TYPE, identity, apiHandler);
  const summary = await drainTaskType(API_TASK_TYPE, apiHandler, identity, { maxTasks: limit });
  return { ok: true, ...summary };
}

export { API_AI_SLUG, API_TASK_TYPE };
