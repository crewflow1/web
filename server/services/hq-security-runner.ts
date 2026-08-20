import "server-only";

/**
 * CrewFlow HQ — Security AI runner (HQ roster completion).
 *
 * Gives the previously-dark `security-ai` roster identity REAL deterministic work: an
 * authority-posture audit of the Capability Registry, run as a Task-Engine task. It owns
 * NO tables — it drains a `security_posture` task off the generic Task Engine through the
 * canonical runner SDK (server/sdk/tasks.ts).
 *
 * Honesty + safety:
 *   • DETERMINISTIC — every finding is a read of a real column (can_execute,
 *     requires_approval, apply-audit stage). NO LLM.
 *   • It REPORTS, it does not remediate: it changes no grant and revokes nothing.
 *   • Reads are SELECT-only and bounded; the only queue write is the sanctioned enqueue.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import {
  summariseSecurityPosture,
  type SecurityGrantRow,
  type SecurityApplyRow,
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

const SECURITY_AI_SLUG = "security-ai";
const SECURITY_TASK_TYPE = "security_posture";

const GRANT_WINDOW = 1000;
const APPLY_WINDOW = 200;

async function readSignals(): Promise<{
  grants: SecurityGrantRow[];
  applyAudit: SecurityApplyRow[];
}> {
  const admin = createAdminClient();

  const { data: grantData, error: grantErr } = await admin
    .from("hq_capability_grants" as never)
    .select("scope_level, scope_key, can_execute, requires_approval")
    .order("created_at", { ascending: false })
    .limit(GRANT_WINDOW);
  if (grantErr) throw new Error(`hq-security-runner: grant read failed — ${grantErr.message}`);

  const { data: applyData, error: applyErr } = await admin
    .from("hq_apply_audit" as never)
    .select("stage")
    .order("recorded_at", { ascending: false })
    .limit(APPLY_WINDOW);
  if (applyErr) throw new Error(`hq-security-runner: apply-audit read failed — ${applyErr.message}`);

  return {
    grants: (grantData ?? []) as unknown as SecurityGrantRow[],
    applyAudit: (applyData ?? []) as unknown as SecurityApplyRow[],
  };
}

const securityHandler: TaskHandler = async () => {
  const { grants, applyAudit } = await readSignals();
  return summariseSecurityPosture(grants, applyAudit, new Date());
};

export async function enqueueSecurityPosture(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveWorkerIdentity(SECURITY_AI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: SECURITY_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${SECURITY_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-security-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runSecurityTask(): Promise<WorkerRunOutcome> {
  const { identity } = await resolveWorkerIdentity(SECURITY_AI_SLUG);
  registerTaskHandler(SECURITY_TASK_TYPE, identity, securityHandler);
  return normaliseWorkerOutcome(await runReadyTask(SECURITY_TASK_TYPE, securityHandler, identity));
}

export async function drainSecurityTasks(limit = 1): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveWorkerIdentity(SECURITY_AI_SLUG);
  registerTaskHandler(SECURITY_TASK_TYPE, identity, securityHandler);
  const summary = await drainTaskType(SECURITY_TASK_TYPE, securityHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

export { SECURITY_AI_SLUG, SECURITY_TASK_TYPE };
