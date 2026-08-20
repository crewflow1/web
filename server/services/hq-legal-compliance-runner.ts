import "server-only";

/**
 * CrewFlow HQ — Legal & Compliance AI runner (HQ roster completion).
 *
 * Gives the previously-dark `legal-compliance-ai` roster identity REAL deterministic work:
 * an approval / sign-off obligation read over the Approval Engine + Decision Centre, run as
 * a Task-Engine task. It owns NO tables — it drains a `compliance_review` task off the
 * generic Task Engine through the canonical runner SDK (server/sdk/tasks.ts).
 *
 * Honesty + safety:
 *   • DETERMINISTIC — a read of hq_approvals.state/expires_at and hq_decisions.status/
 *     delay_until (aggregate counts only — no proposed_payload PII in the result). NO LLM.
 *   • It REPORTS, it does not act: it signs nothing, accepts no terms, commits nothing.
 *   • Reads are SELECT-only and bounded; the only queue write is the sanctioned enqueue.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import {
  summariseCompliance,
  type ComplianceApprovalRow,
  type ComplianceDecisionRow,
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

const LEGAL_COMPLIANCE_AI_SLUG = "legal-compliance-ai";
const LEGAL_COMPLIANCE_TASK_TYPE = "compliance_review";

const APPROVAL_WINDOW = 500;
const DECISION_WINDOW = 500;

async function readSignals(): Promise<{
  approvals: ComplianceApprovalRow[];
  decisions: ComplianceDecisionRow[];
}> {
  const admin = createAdminClient();

  const { data: apprData, error: apprErr } = await admin
    .from("hq_approvals" as never)
    .select("state, expires_at")
    .order("requested_at", { ascending: false })
    .limit(APPROVAL_WINDOW);
  if (apprErr) throw new Error(`hq-legal-compliance-runner: approval read failed — ${apprErr.message}`);

  const { data: decData, error: decErr } = await admin
    .from("hq_decisions" as never)
    .select("status, delay_until")
    .order("created_at", { ascending: false })
    .limit(DECISION_WINDOW);
  if (decErr) throw new Error(`hq-legal-compliance-runner: decision read failed — ${decErr.message}`);

  return {
    approvals: (apprData ?? []) as unknown as ComplianceApprovalRow[],
    decisions: (decData ?? []) as unknown as ComplianceDecisionRow[],
  };
}

const complianceHandler: TaskHandler = async () => {
  const { approvals, decisions } = await readSignals();
  return summariseCompliance(approvals, decisions, new Date());
};

export async function enqueueComplianceReview(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveWorkerIdentity(LEGAL_COMPLIANCE_AI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: LEGAL_COMPLIANCE_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${LEGAL_COMPLIANCE_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-legal-compliance-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runComplianceTask(): Promise<WorkerRunOutcome> {
  const { identity } = await resolveWorkerIdentity(LEGAL_COMPLIANCE_AI_SLUG);
  registerTaskHandler(LEGAL_COMPLIANCE_TASK_TYPE, identity, complianceHandler);
  return normaliseWorkerOutcome(
    await runReadyTask(LEGAL_COMPLIANCE_TASK_TYPE, complianceHandler, identity),
  );
}

export async function drainComplianceTasks(limit = 1): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveWorkerIdentity(LEGAL_COMPLIANCE_AI_SLUG);
  registerTaskHandler(LEGAL_COMPLIANCE_TASK_TYPE, identity, complianceHandler);
  const summary = await drainTaskType(LEGAL_COMPLIANCE_TASK_TYPE, complianceHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

export { LEGAL_COMPLIANCE_AI_SLUG, LEGAL_COMPLIANCE_TASK_TYPE };
