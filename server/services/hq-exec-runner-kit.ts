import "server-only";

/**
 * CrewFlow HQ — shared kit for the executive runners (MP Wave: exec execution path).
 *
 * The 13 executive runners (server/services/hq-{role}-exec-runner.ts) each reach the
 * generic Task Engine through the IDENTICAL canonical surface (enqueueTask +
 * registerTaskHandler / runReadyTask / drainTaskType) — that surface is inlined in
 * every runner so the employee-migration-parity guard can prove they are
 * indistinguishable on the engine (the Reference Employee Rule).
 *
 * This kit holds ONLY the boilerplate that is NOT part of that canonical surface:
 *   • per-slug identity resolution, cached across ticks;
 *   • the run-outcome normaliser shared by every runner.
 * It contains no enqueue/claim/drain call itself — those stay in each runner file.
 */

import { resolveRunnerIdentity } from "@/server/services/hq-runner-identity";
import type { ExecMetricInput } from "@/lib/hq/exec-runners";
import type { EmployeeIdentity } from "@/server/sdk/tasks";
import type { runReadyTask } from "@/server/sdk/tasks";

/**
 * Map any exec board's uniform `{Role}Metric[]` into the review's `ExecMetricInput[]`.
 * Every exec board (except CEO) exposes the SAME metric shape
 * (`{ key, label, kind, value, basis }`), so one structural mapper serves all of them.
 * Pure passthrough — no logic, no derivation.
 */
export function toExecMetrics(
  metrics: ReadonlyArray<{
    key: string;
    label: string;
    kind: "fact" | "derived" | "insufficient";
    value: number | null;
    basis?: string;
  }>,
): ExecMetricInput[] {
  return metrics.map((m) => ({
    key: m.key,
    label: m.label,
    kind: m.kind,
    value: m.value,
    basis: m.basis,
  }));
}

/** Cache the resolved identity per slug so repeated ticks don't re-read the roster. */
const identityCache = new Map<
  string,
  { identity: EmployeeIdentity; employeeId: string | null }
>();

/**
 * Resolve (and cache) the runtime identity for an executive employee by slug. Serves
 * capabilities/posture/memory from the Capability Registry with the default-deny floor
 * as the fail-safe (via resolveRunnerIdentity). `employeeId` is the seeded row UUID, or
 * null when the identity was never seeded (in which case the runner must NOT enqueue an
 * attributed task).
 */
export async function resolveExecIdentity(
  slug: string,
): Promise<{ identity: EmployeeIdentity; employeeId: string | null }> {
  const cached = identityCache.get(slug);
  if (cached) return cached;
  const resolved = await resolveRunnerIdentity(slug);
  identityCache.set(slug, resolved);
  return resolved;
}

export type ExecRunOutcome =
  | { ok: true; status: "completed" | "skipped"; taskId?: string }
  | { ok: false; status: "failed"; taskId?: string; error: string };

/** Normalise a `runReadyTask` outcome into the compact runner summary. */
export function normaliseExecOutcome(
  o: Awaited<ReturnType<typeof runReadyTask>>,
): ExecRunOutcome {
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
