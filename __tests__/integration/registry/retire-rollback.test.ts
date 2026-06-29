import { expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { auditRegistryConfidence } from "@/server/sdk/registry-confidence";
import {
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
 * Also the Behaviour Preservation Rule (15th) and the Single Source of Authority Rule (13th) and —
 * this increment (LR5.4B, the FINAL removal) — the Data Removal Rule (26th) and the Legacy
 * Independence Rule (28th): the legacy authority columns are GONE, so the registry is the SOLE
 * served source and the automatic fail-safe is the default-deny FLOOR (no legacy model remains to
 * roll back to or to compare against).
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
 *      input at all, so there is no operator path back to a legacy model.
 *   2. THE SERVE PATH FAITHFULLY PROJECTS THE REGISTRY — the registry-only served authority equals
 *      what the pure resolver composes from the grants on EVERY dimension (tokens, posture, memory
 *      scope), and the focused {@link resolveServedCapabilities} tokens seam agrees. This is the
 *      registry-native replacement for the retired legacy-baseline comparison: LR5.4B removed the
 *      legacy columns, so there is no baseline left — what "parity" means now is that the serve
 *      path drops or re-sources NO dimension. Retiring the rollback lever changed no served
 *      behaviour (the Behaviour Preservation Rule).
 *   3. THE AUTOMATIC FAIL-SAFE IS RETAINED — a subject the registry is silent about (no grant) is
 *      served the default-deny FLOOR (`source: "floor"`, no tokens, locked posture, isolated
 *      memory), never stranded. The 25th standard retired the *deliberate operator* rollback lever,
 *      NOT the automatic fail-safe — and LR5.4B made that fail-safe the safe default-deny floor (a
 *      fail-safe can only ever grant LESS, never more), not a fallback to a removed legacy model.
 *   4. CONFIDENCE BANKED — {@link auditRegistryConfidence} over the live roster reports
 *      `registryOnlyReady` with every employee `registry-served`, zero backfill gaps and zero read
 *      errors: the independently-runnable evidence the rule requires before rollback retirement.
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
// LR5.4B dropped ai_employees.tools_allowed / permissions / memory_scope; the bridge reads only
// the subject's slug + department to query the registry (every authority dimension is served from
// the grant, with the default-deny floor as the fail-safe).
const EMP_COLUMNS = "slug, department";

/** Coerce a raw ai_employees row into the LegacyEmployee shape the bridge reads. */
function toLegacy(r: Record<string, unknown>): LegacyEmployee {
  return {
    slug: r.slug as string,
    department: (r.department as string | null) ?? null,
  };
}

/** The live roster, in the LegacyEmployee shape (asserts the fetch succeeds). */
async function roster(): Promise<LegacyEmployee[]> {
  const res = await svc().from("ai_employees").select(EMP_COLUMNS);
  expect(res.error, res.error?.message).toBeNull();
  return ((res.data ?? []) as Record<string, unknown>[]).map(toLegacy);
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
      // by which an employee could be served a legacy model instead.
      const served = await resolveServedAuthority(emp, { client: gc });
      if (served.source !== "registry") notRegistry.push(`${emp.slug}=${served.source}`);
    }
    expect(
      notRegistry,
      `served the floor (not registry) with no rollback available: ${notRegistry.join(", ")}`,
    ).toHaveLength(0);
  });

  it("the serve path FAITHFULLY PROJECTS the registry on EVERY dimension without rollback — the registry-native replacement for the legacy baseline (Behaviour Preservation Rule)", async () => {
    const emps = await roster();
    const gc = grantClient();
    const drift: string[] = [];
    for (const emp of emps) {
      const served = await resolveServedAuthority(emp, { client: gc });
      if (served.source !== "registry") continue; // the source itself is asserted by the test above
      // With the legacy columns gone there is no baseline to compare against; the parity that
      // matters now is that the serve path projects EXACTLY what the pure resolver composes from
      // the grants — no dimension dropped or re-sourced.
      const resolved = await resolveAuthorityFromRegistry(gc, {
        slug: emp.slug,
        department: emp.department,
      });
      const sameTokens =
        served.capabilities.tokens.length === resolved.tokens.length &&
        served.capabilities.tokens.every((t, i) => t === resolved.tokens[i]);
      if (!sameTokens) drift.push(`${emp.slug}: tokens diverge from the composed registry authority`);
      if (served.posture.canExecute !== resolved.canExecute) drift.push(`${emp.slug}: canExecute diverges`);
      if (served.posture.requiresApproval !== resolved.requiresApproval) {
        drift.push(`${emp.slug}: requiresApproval diverges`);
      }
      if (served.memoryScope !== resolved.memoryScope) {
        drift.push(`${emp.slug}: memoryScope ${served.memoryScope} ≠ composed ${resolved.memoryScope}`);
      }
    }
    expect(drift, `registry-only serve path out of projection: ${drift.join(" | ")}`).toHaveLength(0);
  });

  it("the focused tokens seam (resolveServedCapabilities) also serves the composed registry tokens, no rollback", async () => {
    const emps = await roster();
    const gc = grantClient();
    const drift: string[] = [];
    for (const emp of emps) {
      const caps = await resolveServedCapabilities(emp, { client: gc });
      if (caps.source !== "registry") continue;
      const resolved = await resolveAuthorityFromRegistry(gc, {
        slug: emp.slug,
        department: emp.department,
      });
      const sameTokens =
        caps.tokens.length === resolved.tokens.length &&
        caps.tokens.every((t, i) => t === resolved.tokens[i]);
      if (!sameTokens) drift.push(`${emp.slug}: served tokens diverge from the composed registry tokens`);
    }
    expect(drift, `served capabilities out of projection: ${drift.join(" | ")}`).toHaveLength(0);
  });

  it("THE AUTOMATIC FAIL-SAFE IS RETAINED — a subject the registry is silent about is served the default-deny FLOOR (not a rollback)", async () => {
    // A synthetic employee with NO registry grant (a backfill gap). SAFE_KEY-clean so the resolver
    // issues the employee-scope query; nothing catches it, so the registry is silent (source "none").
    const phantom: LegacyEmployee = { slug: "lr5_3_phantom_no_grant", department: null };

    // Precondition: the registry really is silent for the phantom (pins the fail-safe scenario).
    const registry = await resolveAuthorityFromRegistry(grantClient(), {
      slug: phantom.slug,
      department: phantom.department,
    });
    expect(registry.source, "phantom must have no applicable grant").toBe("none");

    // No control arg — the fail-safe must be reached AUTOMATICALLY because the registry is silent,
    // never because an operator asked for legacy (that lever is gone). LR5.4B made the fail-safe the
    // default-deny FLOOR (source "floor"): no tokens, the locked posture, never stranded on removed
    // legacy authority.
    const served = await resolveServedAuthority(phantom, { client: grantClient() });
    expect(served.source, "a silent registry must serve the default-deny floor automatically").toBe(
      "floor",
    );
    expect([...served.capabilities.tokens], "the floor grants no capabilities").toHaveLength(0);
    expect(served.posture.canExecute, "the floor posture cannot execute").toBe(false);
    expect(served.posture.requiresApproval, "the floor posture always requires approval").toBe(true);
    expect(served.memoryScope, "the floor memory scope is isolated").toBe("isolated");
  });

  it("CONFIDENCE BANKED — the audit reports registry-only readiness with zero gaps/errors (the evidence the 25th standard requires)", async () => {
    // The production path: no injection, so the audit builds its own service-role admin client and
    // sweeps the live roster — the independently-runnable readiness evidence, gathered end to end.
    const report = await auditRegistryConfidence();

    expect(report.summary.total, "the seeded roster must be present").toBeGreaterThan(0);

    const offenders = report.employees.filter((e) => e.outcome !== "registry-served");
    expect(
      offenders,
      `not registry-served: ${offenders.map((o) => `${o.slug}=${o.outcome}`).join(", ")}`,
    ).toHaveLength(0);

    expect(
      report.summary.registryOnlyReady,
      "the registry-only runtime must be whole without rollback",
    ).toBe(true);
    expect(report.summary.registryServed).toBe(report.summary.total);
    expect(report.summary.backfillGaps, "no employee may depend on the fail-safe").toBe(0);
    expect(report.summary.registryErrors, "the registry must be reliably readable").toBe(0);
  });
});
