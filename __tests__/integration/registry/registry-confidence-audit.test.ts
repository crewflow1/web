import { expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { auditRegistryConfidence } from "@/server/sdk/registry-confidence";
import {
  resolveAuthorityFromRegistry,
  type GrantReadClient,
  type LegacyEmployee,
} from "@/server/sdk/registry-parity";

/**
 * The Capability Registry — LR4 (the production-confidence audit) real-Postgres proof.
 *
 * CEO Directive #015 / D-05, Legacy Removal increment 4. ADR:
 * docs/bible/decisions/0010-capability-registry.md. Governing rules: the Rollback Readiness
 * Rule (17th §2 standard) — "confidence is sustained production stability, not a single green
 * deploy" — the Shadow Validation Rule (16th), and the **Compatibility Layer Rule** (21st),
 * whose "measurable exit criteria" and "continuous parity validation" attributes this
 * instrument makes concrete. It implements the Legacy Removal Proposal's **C4 — "Bank
 * production confidence (§4)"** increment, the deliberate confidence-banking phase that gates
 * EVERY removal increment (C5+).
 *
 * The unit tier proves the PURE confidence law (classify + summarize); the security tier pins
 * the instrument's read-only / delegating contract. This tier proves the BEHAVIOUR that text
 * can't — that the ACTUAL sweep, run against a live registry, produces the §4 confidence
 * signal correctly:
 *
 *   1. CONFIDENCE BANKED — under registry authority, the full production sweep (createAdminClient
 *      + live roster + live grants) reports EVERY live employee served the registry IN PARITY:
 *      registryOnlyReady, zero backfill gaps (§4.4), zero divergence, zero read errors. This is
 *      the first banked evidence snapshot that the registry-only runtime is whole.
 *   2. A BACKFILL GAP IS DETECTED — a subject the registry is silent about is classified
 *      `backfill-gap` and defeats readiness (the §4.4 "every employee has an authored grant"
 *      check the removal phase depends on).
 *   3. A DIVERGENCE IS DETECTED AND NAMED — an out-of-band grant change is classified
 *      `registry-divergent` with the offending dimension named (§4.2 "every divergence must be
 *      accounted for"), then parity is restored — leaving no trace.
 *
 * LR5.3 (the Rollback Independence Rule, 25th §2 standard) retired the rollback control, so the
 * audit no longer takes a `control` opt and `rolled-back` is no longer a measurable outcome. The
 * automatic fail-safe (registry read error / a subject the registry is silent about) and the
 * whole confidence instrument remain — this audit is the very evidence the rule demands.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database, FAILED
 * loudly in CI if the database is missing.
 *
 * ai_employees / hq_capability_grants are service-role-only HQ internals not in the generated
 * Database types, so — like the R1/R2/R3/R4/LR3 suites — the typed client is cast to the
 * minimal surface exercised here.
 */

type QueryResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<QueryResult<T>>;
type Filterable<T> = Term<T> & {
  eq(column: string, value: unknown): Filterable<T>;
  select(columns?: string): Filterable<T>;
};
type RegistryTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  update(patch: Record<string, unknown>): Filterable<null>;
};
type DbClient = { from(table: string): RegistryTable };

const svc = (): DbClient => serviceClient() as unknown as DbClient;
const grantClient = (): GrantReadClient => serviceClient() as unknown as GrantReadClient;
const EMP_COLUMNS = "slug, department, tools_allowed, permissions, memory_scope";

/** Coerce a raw ai_employees row into the LegacyEmployee shape. */
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

describeIntegration("Capability Registry · LR4 production-confidence audit (D-05)", () => {
  it("CONFIDENCE BANKED — the full production sweep reports every employee served registry IN PARITY", async () => {
    // The production path: no injection, so the audit builds its own service-role admin client,
    // reads the live roster, and reads the live grants — proving the instrument end to end.
    const report = await auditRegistryConfidence();

    expect(report.summary.total, "the seeded roster must be present").toBeGreaterThan(0);

    // The §4 confidence bar, as one boolean: the registry-only runtime is whole at this instant.
    const offenders = report.employees.filter((e) => e.outcome !== "registry-parity");
    expect(
      offenders,
      `not registry-parity: ${offenders.map((o) => `${o.slug}=${o.outcome}`).join(", ")}`,
    ).toHaveLength(0);

    expect(report.summary.registryOnlyReady, "registry-only runtime must be whole").toBe(true);
    expect(report.summary.registryParity).toBe(report.summary.total);
    expect(report.summary.backfillGaps, "§4.4: no employee may rely on the silent fallback").toBe(0);
    expect(report.summary.registryDivergent, "§4.2: zero unexplained divergence").toBe(0);
    expect(report.summary.registryErrors, "the registry must be reliably readable").toBe(0);
  });

  it("A BACKFILL GAP IS DETECTED — a subject the registry is silent about defeats readiness (§4.4)", async () => {
    // A synthetic employee with NO registry grant (a backfill gap). SAFE_KEY-clean so the
    // resolver issues the employee-scope query; the flat mirror means nothing else catches it.
    const phantom: LegacyEmployee = {
      slug: "lr4_phantom_no_grant",
      department: null,
      tools_allowed: ["tasks.read", "memory.read"],
      permissions: { scopes: ["comms.send"] },
      memory_scope: null,
    };

    // Precondition: the registry really is silent for the phantom (pins the gap scenario).
    const registry = await resolveAuthorityFromRegistry(grantClient(), {
      slug: phantom.slug,
      department: phantom.department,
    });
    expect(registry.source, "phantom must have no applicable grant").toBe("none");

    const report = await auditRegistryConfidence({
      roster: [phantom],
      client: grantClient(),
    });

    expect(report.summary.total).toBe(1);
    expect(report.summary.backfillGaps).toBe(1);
    expect(report.summary.registryOnlyReady, "a gap defeats readiness").toBe(false);
    expect(report.employees[0]?.outcome).toBe("backfill-gap");
  });

  it("A DIVERGENCE IS DETECTED AND NAMED — an out-of-band change is registry-divergent, then parity restored", async () => {
    const emps = [...(await roster())].sort((a, b) => a.slug.localeCompare(b.slug));
    const sample = emps[0];
    expect(sample, "need a sampled employee to break").toBeDefined();
    if (!sample) return;

    // Read the RAW grant tokens first, so the repair restores them byte-exact (no trace).
    const rawBefore = await svc()
      .from("hq_capability_grants")
      .select("tokens")
      .eq("scope_level", "employee")
      .eq("scope_key", sample.slug);
    expect(rawBefore.error, rawBefore.error?.message).toBeNull();
    const originalTokens = (rawBefore.data?.[0]?.tokens as string[] | undefined) ?? [];
    expect(originalTokens.length, "need a token to drop to create divergence").toBeGreaterThan(0);

    // Break the employee grant out-of-band: drop one token (a permitted content edit). The
    // legacy columns are untouched, so the registry now DIVERGES from the legacy baseline.
    const broke = await svc()
      .from("hq_capability_grants")
      .update({ tokens: originalTokens.slice(1) })
      .eq("scope_level", "employee")
      .eq("scope_key", sample.slug);
    expect(broke.error, broke.error?.message).toBeNull();

    try {
      const report = await auditRegistryConfidence({
        roster: [sample],
        client: grantClient(),
      });
      expect(report.summary.registryDivergent).toBe(1);
      expect(report.summary.registryOnlyReady, "a divergence defeats readiness").toBe(false);
      expect(report.employees[0]?.outcome).toBe("registry-divergent");
      expect(report.employees[0]?.divergence, "the offending dimension must be named (§4.2)").toContain(
        "tokens",
      );
    } finally {
      // Repair to the exact original tokens — the instrument must leave no trace.
      const repaired = await svc()
        .from("hq_capability_grants")
        .update({ tokens: originalTokens })
        .eq("scope_level", "employee")
        .eq("scope_key", sample.slug);
      expect(repaired.error, repaired.error?.message).toBeNull();
    }

    // After repair the sweep is back to parity for the sample.
    const after = await auditRegistryConfidence({
      roster: [sample],
      client: grantClient(),
    });
    expect(after.employees[0]?.outcome).toBe("registry-parity");
  });
});
