import "server-only";

/**
 * CrewFlow HQ — Database AI runner (HQ roster completion).
 *
 * Gives the previously-dark `database-ai` roster identity REAL deterministic work: an
 * event-bus / consumer integrity read over the retry ledger, run as a Task-Engine task.
 * It owns NO tables — it drains a `database_integrity` task off the generic Task Engine
 * through the canonical runner SDK (server/sdk/tasks.ts).
 *
 * Honesty + safety:
 *   • DETERMINISTIC — every signal is a read of a real column (hq_consumer_retries.attempts,
 *     hq_event_consumers.consumer). NO LLM.
 *   • It REPORTS, it does not repair: it runs no migration and mutates no data.
 *   • Reads are SELECT-only and bounded; the only queue write is the sanctioned enqueue.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import {
  summariseDataIntegrity,
  type DbRetryRow,
  type DbConsumerRow,
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

const DATABASE_AI_SLUG = "database-ai";
const DATABASE_TASK_TYPE = "database_integrity";

const RETRY_WINDOW = 500;
const CONSUMER_WINDOW = 200;

async function readSignals(): Promise<{
  retries: DbRetryRow[];
  consumers: DbConsumerRow[];
}> {
  const admin = createAdminClient();

  const { data: retryData, error: retryErr } = await admin
    .from("hq_consumer_retries" as never)
    .select("consumer, attempts")
    .order("last_failed_at", { ascending: false })
    .limit(RETRY_WINDOW);
  if (retryErr) throw new Error(`hq-database-runner: retry read failed — ${retryErr.message}`);

  const { data: consumerData, error: consumerErr } = await admin
    .from("hq_event_consumers" as never)
    .select("consumer")
    .order("updated_at", { ascending: false })
    .limit(CONSUMER_WINDOW);
  if (consumerErr) throw new Error(`hq-database-runner: consumer read failed — ${consumerErr.message}`);

  return {
    retries: (retryData ?? []) as unknown as DbRetryRow[],
    consumers: (consumerData ?? []) as unknown as DbConsumerRow[],
  };
}

const databaseHandler: TaskHandler = async () => {
  const { retries, consumers } = await readSignals();
  return summariseDataIntegrity(retries, consumers, new Date());
};

export async function enqueueDatabaseIntegrity(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveWorkerIdentity(DATABASE_AI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: DATABASE_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${DATABASE_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-database-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runDatabaseTask(): Promise<WorkerRunOutcome> {
  const { identity } = await resolveWorkerIdentity(DATABASE_AI_SLUG);
  registerTaskHandler(DATABASE_TASK_TYPE, identity, databaseHandler);
  return normaliseWorkerOutcome(await runReadyTask(DATABASE_TASK_TYPE, databaseHandler, identity));
}

export async function drainDatabaseTasks(limit = 1): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveWorkerIdentity(DATABASE_AI_SLUG);
  registerTaskHandler(DATABASE_TASK_TYPE, identity, databaseHandler);
  const summary = await drainTaskType(DATABASE_TASK_TYPE, databaseHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

export { DATABASE_AI_SLUG, DATABASE_TASK_TYPE };
