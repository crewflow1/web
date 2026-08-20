import "server-only";

/**
 * CrewFlow HQ — Onboarding AI runner (HQ roster completion).
 *
 * Gives the previously-dark `onboarding-ai` roster identity REAL deterministic work: an
 * activation-funnel read over the org estate, run as a Task-Engine task. It owns NO tables
 * — it drains an `onboarding_nudges` task off the generic Task Engine through the canonical
 * runner SDK (server/sdk/tasks.ts).
 *
 * Honesty + safety:
 *   • DETERMINISTIC — a funnel read of organizations.onboarding_state / onboarding_percent
 *     / status (aggregate counts only — no customer PII in the result). NO LLM.
 *   • It REPORTS, it does not act: it touches no customer account.
 *   • Reads are SELECT-only and bounded; the only queue write is the sanctioned enqueue.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { summariseOnboarding, type OnboardingOrgRow } from "@/lib/hq/roster-workers";
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

const ONBOARDING_AI_SLUG = "onboarding-ai";
const ONBOARDING_TASK_TYPE = "onboarding_nudges";

const ORG_WINDOW = 1000;

async function readSignals(): Promise<{ orgs: OnboardingOrgRow[] }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations" as never)
    .select("status, onboarding_state, onboarding_percent")
    .order("created_at", { ascending: false })
    .limit(ORG_WINDOW);
  if (error) throw new Error(`hq-onboarding-runner: org read failed — ${error.message}`);
  return { orgs: (data ?? []) as unknown as OnboardingOrgRow[] };
}

const onboardingHandler: TaskHandler = async () => {
  const { orgs } = await readSignals();
  return summariseOnboarding(orgs, new Date());
};

export async function enqueueOnboardingNudges(
  now: Date = new Date(),
): Promise<{ ok: boolean; taskId?: string; skipped?: true; error?: string }> {
  const { employeeId } = await resolveWorkerIdentity(ONBOARDING_AI_SLUG);
  if (!employeeId) return { ok: true, skipped: true };
  const day = now.toISOString().slice(0, 10);
  const enq = await enqueueTask({
    taskType: ONBOARDING_TASK_TYPE,
    priority: "low",
    maxRetries: 2,
    assignedEmployeeId: employeeId,
    dedupeKey: `${ONBOARDING_TASK_TYPE}:${day}`,
    origin: "cron",
  });
  if (!enq.ok) {
    console.error("[hq-onboarding-runner] enqueue failed", enq.error);
    return { ok: false, error: enq.error };
  }
  return { ok: true, taskId: enq.task.id };
}

export async function runOnboardingTask(): Promise<WorkerRunOutcome> {
  const { identity } = await resolveWorkerIdentity(ONBOARDING_AI_SLUG);
  registerTaskHandler(ONBOARDING_TASK_TYPE, identity, onboardingHandler);
  return normaliseWorkerOutcome(
    await runReadyTask(ONBOARDING_TASK_TYPE, onboardingHandler, identity),
  );
}

export async function drainOnboardingTasks(limit = 1): Promise<{ ok: boolean } & DrainSummary> {
  const { identity } = await resolveWorkerIdentity(ONBOARDING_AI_SLUG);
  registerTaskHandler(ONBOARDING_TASK_TYPE, identity, onboardingHandler);
  const summary = await drainTaskType(ONBOARDING_TASK_TYPE, onboardingHandler, identity, {
    maxTasks: limit,
  });
  return { ok: true, ...summary };
}

export { ONBOARDING_AI_SLUG, ONBOARDING_TASK_TYPE };
