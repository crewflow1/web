import "server-only";

/**
 * CrewFlow HQ — shared kit for the roster-worker runners (MP Wave: HQ roster completion).
 *
 * The twelve roster-worker runners (server/services/hq-{role}-runner.ts) each reach the
 * generic Task Engine through the IDENTICAL canonical surface (enqueueTask +
 * registerTaskHandler / runReadyTask / drainTaskType) — that surface is inlined in every
 * runner so the employee-migration-parity guard can prove they are indistinguishable on
 * the engine (the Reference Employee Rule).
 *
 * This kit holds ONLY the boilerplate that is NOT part of that canonical surface: per-slug
 * identity resolution (cached across ticks) and the run-outcome normaliser shared by every
 * runner. It contains no enqueue/claim/drain call itself — those stay in each runner file,
 * exactly like the exec runners' hq-exec-runner-kit.
 */

import { resolveRunnerIdentity } from "@/server/services/hq-runner-identity";
import type { EmployeeIdentity, runReadyTask } from "@/server/sdk/tasks";

/** Cache the resolved identity per slug so repeated ticks don't re-read the roster. */
const identityCache = new Map<
  string,
  { identity: EmployeeIdentity; employeeId: string | null }
>();

/**
 * Resolve (and cache) the runtime identity for a roster-worker employee by slug. Serves
 * capabilities/posture/memory from the Capability Registry with the default-deny floor as
 * the fail-safe (via resolveRunnerIdentity). `employeeId` is the seeded row UUID, or null
 * when the identity was never seeded (in which case the runner must NOT enqueue an
 * attributed task — assigned_employee_id is a UUID column).
 */
export async function resolveWorkerIdentity(
  slug: string,
): Promise<{ identity: EmployeeIdentity; employeeId: string | null }> {
  const cached = identityCache.get(slug);
  if (cached) return cached;
  const resolved = await resolveRunnerIdentity(slug);
  identityCache.set(slug, resolved);
  return resolved;
}

export type WorkerRunOutcome =
  | { ok: true; status: "completed" | "skipped"; taskId?: string }
  | { ok: false; status: "failed"; taskId?: string; error: string };

/** Normalise a `runReadyTask` outcome into the compact runner summary. */
export function normaliseWorkerOutcome(
  o: Awaited<ReturnType<typeof runReadyTask>>,
): WorkerRunOutcome {
  switch (o.status) {
    case "completed":
      return { ok: true, status: "completed", taskId: o.taskId };
    case "empty":
      return { ok: true, status: "skipped" };
    case "failed":
      return { ok: false, status: "failed", taskId: o.taskId, error: o.error };
    case "lease_lost":
      return {
        ok: false,
        status: "failed",
        taskId: o.taskId,
        error: "lease lost (reaped or re-claimed)",
      };
    case "error":
      return { ok: false, status: "failed", error: o.error };
  }
}
