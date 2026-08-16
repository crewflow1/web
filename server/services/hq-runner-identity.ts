import "server-only";

/**
 * CrewFlow HQ — shared runtime-identity resolver for the roster runners (MP Wave R3).
 *
 * Every deterministic roster runner (server/services/hq-*-runner.ts) resolves its
 * EmployeeIdentity the SAME way the migrated employees do (hq-research / hq-qualification):
 * find the seeded row by slug and serve EVERY authority dimension — capabilities, posture
 * AND memory scope — from the now-SOLE-authoritative Capability Registry, with the
 * default-deny FLOOR as the automatic fail-safe. `resolveServedAuthority` returns the
 * floor (no tokens, locked posture, isolated memory) on a registry read error or a
 * subject the registry is silent about, so the switch can never strand an employee.
 *
 * Factored out only so the three runners share ONE identity path — the runners still
 * call the canonical engine surface (enqueueTask / registerTaskHandler / runReadyTask /
 * drainTaskType) directly, exactly like every migrated employee (the Reference Employee
 * Rule, machine-checked by employee-migration-parity).
 */

import { listAiEmployees } from "@/server/services/ai-employees";
import { resolveServedAuthority } from "@/server/sdk/registry-parity";
import type { EmployeeIdentity } from "@/server/sdk/tasks";

export interface ResolvedRunnerIdentity {
  identity: EmployeeIdentity;
  /** The seeded employee row id (a UUID), or null when the identity was never seeded. */
  employeeId: string | null;
}

/**
 * Resolve the runtime identity for a roster runner by its slug. `employeeId` is the
 * seeded row's UUID when present (so tasks can be attributed on the Boardroom) or null
 * when the employee was never seeded — in which case the caller must NOT enqueue an
 * attributed task (assigned_employee_id is a UUID column).
 */
export async function resolveRunnerIdentity(
  slug: string,
): Promise<ResolvedRunnerIdentity> {
  const employees = await listAiEmployees();
  const emp = employees.find((e) => e.slug === slug) ?? null;

  // The seeded row id when present; the stable slug as a last-resort opaque identity
  // (lease owner only) if the employee was never seeded.
  const identity: EmployeeIdentity = {
    employeeId: emp?.id ?? slug,
    slug,
  };

  if (emp) {
    const served = await resolveServedAuthority(emp);
    identity.capabilities = served.capabilities;
    identity.posture = served.posture;
    identity.memoryScope = served.memoryScope;
  }

  return { identity, employeeId: emp?.id ?? null };
}
