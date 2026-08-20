import "server-only";

/**
 * CrewFlow HQ — Memory Manager AI runner (HQ roster completion).
 *
 * Gives the previously-dark `memory-manager-ai` roster identity REAL deterministic work: a
 * shared-memory curation scan over the memory substrate, run as a Task-Engine task. It owns
 * NO tables — it drains a `memory_curation` task off the generic Task Engine through the
 * canonical runner SDK (server/sdk/tasks.ts).
 *
 * Honesty + safety:
 *   • DETERMINISTIC — a read of hq_memories.expires_at / last_accessed_at /
 *     consolidated_into / pinned and hq_memory_versions row count (aggregate counts only —
 *     no memory body/title in the result). NO LLM.
 *   • It REPORTS, it does not act: it forgets nothing and rewrites no memory.
 *   • Reads are SELECT-only and bounded; the only queue write is the sanctioned enqueue.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import {
  summariseMemoryCuration,
  type MemoryRow,
  type MemoryVersionRow,
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

const MEMORY_MANAGER_AI_SLUG = "memory-manager-ai";
const MEMORY_MANAGER_TASK_TYPE = "memory_curation";

const MEMORY_WINDOW = 1000;
const VERSION_WINDOW = 1000;

async function readSignals(): Promise<{
  memories: MemoryRow[];
  versions: MemoryVersionRow[];
}> {
  const admin = createAdminClient();

  const { data: memData, error: memErr } = await admin
    .from("hq_memories" as never)
    .select("status, expires_at, last_accessed_at, consolidated_into, pinned")
    .order("updated_at", { ascending: false })
    .limit(MEMORY_WINDOW);
  if (memErr) throw new Error(`hq-memory-manager-runner: memory read failed — ${memErr.message}`);

  const { data: verData, error: verErr } = await admin
    .from("hq_memory_versions" as never)
    .select("memory_id")
    .order("created_at", { ascending: false })
    .limit(VERSION_WINDOW);
  if (verErr) throw new Error(`hq-memory-manager-runner: version read failed — ${verErr.message}`);

  return {
    memories: (memData ?? []) as unknown as MemoryRow[],
    versions: (verData ?? []) as unknown as MemoryVersionRow[],
  };
}

const memoryHandler: TaskHandler = async () => {
  const { memories, versions } = await readSignals();
  return summariseMemoryCuration(memories, versions, new Date());
};

export async function enqueueMemoryCuration(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveWorkerIdentity(MEMORY_MANAGER_AI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: MEMORY_MANAGER_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${MEMORY_MANAGER_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-memory-manager-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runMemoryCurationTask(): Promise<WorkerRunOutcome> {
  const { identity } = await resolveWorkerIdentity(MEMORY_MANAGER_AI_SLUG);
  registerTaskHandler(MEMORY_MANAGER_TASK_TYPE, identity, memoryHandler);
  return normaliseWorkerOutcome(
    await runReadyTask(MEMORY_MANAGER_TASK_TYPE, memoryHandler, identity),
  );
}

export async function drainMemoryCurationTasks(
  limit = 1,
): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveWorkerIdentity(MEMORY_MANAGER_AI_SLUG);
  registerTaskHandler(MEMORY_MANAGER_TASK_TYPE, identity, memoryHandler);
  const summary = await drainTaskType(MEMORY_MANAGER_TASK_TYPE, memoryHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

export { MEMORY_MANAGER_AI_SLUG, MEMORY_MANAGER_TASK_TYPE };
