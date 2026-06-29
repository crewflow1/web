import { expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { auditRegistryConfidence } from "@/server/sdk/registry-confidence";
import {
  legacyAuthorityOf,
  resolveAuthorityFromRegistry,
  resolveServedAuthority,
  resolveServedCapabilities,
  type GrantReadClient,
  type LegacyEmployee,
} from "@/server/sdk/registry-parity";

/**
 * The Capability Registry — LR5.3 (Retire the Rollback Mechanisms) real-Postgres behaviour proof.
 *
 * CEO Directive #015 / D-05, Legacy Removal increment 5.3. ADR:
 * docs/bible/decisions/0010-capability-registry.md. Governing standards (Kernel Contract Map §2):
 * the **Rollback Independence Rule** (25th — set on the LR5.2 review): "Rollback mechanisms must be
 * removable independently of the legacy implementation they protect. Before rollback infrastructure
 * is retired, the production system must demonstrate that continued operation no longer depends on
 * rollback activation. Rollback retirement must itself be independently reviewed and validated."
 * Also the Rollback Readiness Rule (17th), the Behaviour Preservation Rule (15th) and the Single
 * Source of Authority Rule (13th).
 *
 * The security tier pins the LR5.3 CONTRACT against source text (the operator rollback lever — the
 * CAPABILITY_AUTHORITY_SOURCE env enum, the `control` opt threaded to the switch, the deliberate
 * `reason: "rollback"` decision branch and its `rolled-back` confidence outcome — is GONE from the
 * env, the pure law, the bridge and the audit). This tier proves the BEHAVIOUR that text can't —
 * the literal evidence the 25th standard demands before rollback retirement is approved: that the
 * live runtime serves the registry-only path with NO rollback available, and that continued
 * operation no longer depends on rollback activation:
 *
 *   1. STABLE REGISTRY-ONLY OPERATION — for EVERY live employee the runtime authority switch
 *      ({@link resolveServedAuthority}, called with NO control because there IS none) serves the
 *      REGISTRY (`source: "registry"`), unconditionally. The serve path no longer takes a rollback
 *      input at all, so there is no operator path back to legacy. This is the "continued operation
 *      no longer depends on rollback activation" demonstration.
 *   2. PARITY PRESERVED WITHOUT ROLLBACK — the registry-only served authority equals the legacy
 *      baseline on EVERY dimension (tokens, posture, memory scope) across the whole roster, and the
 *      focused {@link resolveServedCapabilities} tokens seam agrees. Retiring the rollback lever
 *      changed no served behaviour (the Behaviour Preservation Rule).
 *   3. THE AUTOMATIC FAIL-SAFE IS RETAINED — a subject the registry is silent about (no grant) is
 *      still served its retained legacy view via the AUTOMATIC fail-safe (`source: "ai_employees"`),
 *      never stranded. The 25th standard retires the *deliberate operator* rollback lever, NOT the
 *      automatic fail-safe that protects against an unreachable / not-yet-authored registry — that
 *      fail-safe, and the legacy columns it reads, are explicitly preserved.
 *   4. CONFIDENCE BANKED — {@link auditRegistryConfidence} over the live roster reports
 *      `registryOnlyReady` with zero divergence, zero backfill gaps and zero read errors: the
 *      independently-runnable evidence the rule requires before rollback retirement is approved.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED
 * loudly in CI if the database is missing.
 *
 * ai_employees / hq_capability_grants are service-role-only HQ internals not in the generated
 * Database types, so — like the R1/R2/R3/R4/LR3/LR4/LR5.2 suites — the typed client is cast to the
 * minimal surface exercised here.
 */

type QueryResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<QueryResult<T>>;
type Filterable<T> = Term<T> & {
  eq(column: string, value: unknown): Filterable<T>;
  select(columns?: string): Filterable<T>;
};
type DbClient = {
  from(table: string): { select(columns?: string): Filterable<Record<string, unknown>[]> };
};

const svc = (): DbClient => serviceClient() as unknown as DbClient;
const grantClient = (): GrantReadClient => serviceClient() as unknown as GrantReadClient;
const EMP_COLUMNS = "slug, department, tools_allowed, permissions, memory_scope";

/** Coerce a raw ai_employees row into the LegacyEmployee shape the bridge reads. */
function toLegacy(r: Record<string, unknown>): LegacyEmployee {
  return {
    slug: r.slug as string,
    department: (r.department as string | null) ?? null,
    tools_allowed: (r.tools_allowed as string[] | null) ?? null,
    permissions: (r.permissions as LegacyEmployee["permissions"]) ?? null,
    memory_scope: (r.memory_scope as string | null) ?? null,
  };
}

/** The live roster, in the LegacyEmployee shape (asserts the fetch succeeds). */
async function roster(): Promise<LegacyEmployee[]> {
  const res = await svc().from("ai_employees").select(EMP_COLUMNS);
  expect(res.error, res.error?.message).toBeNull();
  return ((res.data ?? []) as Record<string, unknown>[]).map(toLegacy);
}

/** Order-insensitive string-array equality. */
function sortedEq(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

describeIntegration("Capability Registry · LR5.3 stable registry-only operation, no rollback (D-05)", () => {
  it("serves the REGISTRY for EVERY live employee through the switch — NO control, unconditional (the 25th standard's 'no dependence on rollback activation')", async () => {
    const emps = await roster();
    expect(emps.length, "the seeded roster must be present").toBeGreaterThan(0);

    const gc = grantClient();
    const notRegistry: string[] = [];
    for (const emp of emps) {
      // No control arg — the rollback lever is retired, so the switch takes only the optional
      // test client. The runtime serves the registry unconditionally; there is no operator path
      // by which an employee could be served the legacy model instead.
      const served = await resolveServedAuthority(emp, { client: gc });
      if (served.source !== "registry") notRegistry.push(`${emp.slug}=${served.source}`);
    }
    expect(
      notRegistry,
      `served legacy (not registry) with no rollback available: ${notRegistry.join(", ")}`,
    ).toHaveLength(0);
  });

  it("preserves authority PARITY on EVERY dimension without rollback — registry-only equals the legacy baseline (Behaviour Preservation Rule)", async () => {
    const emps = await roster();
    const gc = grantClient();
    const drift: string[] = [];
    for (const emp of emps) {
      const served = await resolveServedAuthority(emp, { client: gc });
      if (served.source !== "registry") continue; // the source itself is asserted by the test above
      const legacy = legacyAuthorityOf(emp);
      if (!sortedEq(served.capabilities.tokens, legacy.tokens)) {
        drift.push(`${emp.slug}: tokens diverge from the legacy baseline`);
      }
      if (served.posture.canExecute !== legacy.canExecute) {
        drift.push(`${emp.slug}: canExecute diverges`);
      }
      if (served.posture.requiresApproval !== legacy.requiresApproval) {
        drift.push(`${emp.slug}: requiresApproval diverges`);
      }
      if (served.memoryScope !== legacy.memoryScope) {
        drift.push(`${emp.slug}: memoryScope ${served.memoryScope} ≠ legacy ${legacy.memoryScope}`);
      }
    }
    expect(drift, `registry-only authority out of parity: ${drift.join(" | ")}`).toHaveLength(0);
  });

  it("the focused tokens seam (resolveServedCapabilities) also serves the registry tokens in parity, no rollback", async () => {
    const emps = await roster();
    const gc = grantClient();
    const drift: string[] = [];
    for (const emp of emps) {
      const caps = await resolveServedCapabilities(emp, { client: gc });
      const legacy = legacyAuthorityOf(emp);
      // At the flat mirror the registry tokens equal the legacy tokens.
      if (!sortedEq(caps.tokens, legacy.tokens)) {
        drift.push(`${emp.slug}: served tokens diverge from legacy`);
      }
    }
    expect(drift, `served capabilities out of parity: ${drift.join(" | ")}`).toHaveLength(0);
  });

  it("THE AUTOMATIC FAIL-SAFE IS RETAINED — a subject the registry is silent about is still served its legacy view (not a rollback)", async () => {
    // A synthetic employee with NO registry grant (a backfill gap). SAFE_KEY-clean so the resolver
    // issues the employee-scope query; the flat mirror means no global/department grant catches it,
    // so the registry is silent (source "none").
    const phantom: LegacyEmployee = {
      slug: "lr5_3_phantom_no_grant",
      department: null,
      tools_allowed: ["tasks.read", "memory.read"],
      permissions: { scopes: ["comms.send"], requires_approval: true },
      memory_scope: null,
    };

    // Precondition: the registry really is silent for the phantom (pins the fail-safe scenario).
    const registry = await resolveAuthorityFromRegistry(grantClient(), {
      slug: phantom.slug,
      department: phantom.department,
    });
    expect(registry.source, "phantom must have no applicable grant").toBe("none");

    // No control arg — the fail-safe must be reached AUTOMATICALLY because the registry is silent,
    // never because an operator asked for legacy (that lever is gone). The switch still protects.
    const served = await resolveServedAuthority(phantom, { client: grantClient() });
    const legacy = legacyAuthorityOf(phantom);
    expect(served.source, "a silent registry must fall back to legacy automatically").toBe(
      "ai_employees",
    );
    expect(sortedEq(served.capabilities.tokens, legacy.tokens)).toBe(true);
    expect(served.capabilities.tokens.length, "the phantom keeps its own tokens").toBeGreaterThan(0);
    expect(served.posture.requiresApproval).toBe(legacy.requiresApproval);
  });

  it("CONFIDENCE BANKED — the audit reports registry-only readiness with zero gaps/divergence/errors (the evidence the 25th standard requires)", async () => {
    // The production path: no injection, so the audit builds its own service-role admin client and
    // sweeps the live roster — the independently-runnable readiness evidence, gathered end to end.
    const report = await auditRegistryConfidence();

    expect(report.summary.total, "the seeded roster must be present").toBeGreaterThan(0);

    const offenders = report.employees.filter((e) => e.outcome !== "registry-parity");
    expect(
      offenders,
      `not registry-parity: ${offenders.map((o) => `${o.slug}=${o.outcome}`).join(", ")}`,
    ).toHaveLength(0);

    expect(
      report.summary.registryOnlyReady,
      "the registry-only runtime must be whole without rollback",
    ).toBe(true);
    expect(report.summary.registryParity).toBe(report.summary.total);
    expect(report.summary.backfillGaps, "no employee may depend on the fail-safe").toBe(0);
    expect(report.summary.registryDivergent, "zero unexplained divergence").toBe(0);
    expect(report.summary.registryErrors, "the registry must be reliably readable").toBe(0);
  });
});
