import { expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import {
  legacyAuthorityOf,
  resolveAuthorityFromRegistry,
  resolveServedAuthority,
  resolveServedCapabilities,
  type GrantReadClient,
  type LegacyEmployee,
} from "@/server/sdk/registry-parity";
import { resolveEmployeeCapabilities } from "@/server/sdk/tasks";

/**
 * The Capability Registry — R4 + LR3 (runtime authority switch) real-Postgres behaviour proof.
 *
 * CEO Directive #015 / D-05. ADR: docs/bible/decisions/0010-capability-registry.md
 * (Decision 5). Governing rules: the Behaviour Preservation Rule (Kernel Contract Map §2,
 * fifteenth standard), the Shadow Validation Rule (sixteenth standard) — "production
 * authority may switch only after parity has been continuously demonstrated" — and the
 * Registry Completeness Rule (twentieth), whose SERVING clause LR3 advances.
 *
 * The security tier pins R4's CONTRACT against its source text; this tier proves the
 * BEHAVIOUR that text can't — that the ACTUAL serve path (resolveServedCapabilities, the
 * function the identity assembly now calls in place of the bare legacy resolver) behaves
 * correctly against a live registry:
 *
 *   1. SWITCH PRESERVES PARITY — with the registry authoritative, every live employee is
 *      served the registry (`source: "registry"`) AND the served tokens equal the legacy
 *      tokens (the flat mirror): the transition is behaviour-preserving at the cut.
 *   2. ROLLBACK SERVES LEGACY — with the control rolled back to "legacy", every employee is
 *      served the legacy resolution VERBATIM and the registry is not served.
 *   3. FAIL-SAFE NEVER STRANDS — under registry authority, a subject the registry is silent
 *      about (no grant — a backfill gap) is still served its retained legacy capabilities.
 *   4. REGISTRY IS TRULY AUTHORITATIVE — under registry authority, an out-of-band divergence
 *      is SERVED from the registry (monitored, not silently repaired, not a fallback),
 *      proving the registry — not the legacy model — is the served source.
 *
 * The LR3 block below proves the SAME four behaviours for the FULL served authority
 * (resolveServedAuthority) — extending the switch from tokens to posture AND memory scope,
 * the last runtime reads R4 left on the legacy model: every dimension is served from the
 * registry in parity, rolls back together, and fails safe together.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database,
 * FAILED loudly in CI if the database is missing.
 *
 * ai_employees / hq_capability_grants are service-role-only HQ internals not in the
 * generated Database types, so — like the R1/R2/R3 suites — the typed client is cast to the
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

describeIntegration("Capability Registry · R4 served-authority switch (D-05)", () => {
  it("the switch serves the REGISTRY as authoritative, preserving parity for every employee", async () => {
    const emps = await roster();
    expect(emps.length, "the seeded roster must be present").toBeGreaterThan(0);

    const gc = grantClient();
    const drift: string[] = [];
    for (const emp of emps) {
      const served = await resolveServedCapabilities(emp, { client: gc, control: "registry" });
      // The served source is the registry (the R4 transition) and the served tokens equal
      // the legacy tokens (parity preserved through the switch — the flat mirror).
      if (served.source !== "registry") {
        drift.push(`${emp.slug}: served ${served.source}, not registry`);
        continue;
      }
      const legacyTokens = resolveEmployeeCapabilities(emp).tokens;
      const same =
        served.tokens.length === legacyTokens.length &&
        served.tokens.every((t, i) => t === legacyTokens[i]);
      if (!same) drift.push(`${emp.slug}: tokens diverge through the switch`);
    }
    expect(drift, `R4 switch out of parity: ${drift.join(" | ")}`).toHaveLength(0);
  });

  it("ROLLBACK (control 'legacy') serves the legacy resolution VERBATIM and never the registry", async () => {
    const emps = await roster();
    expect(emps.length).toBeGreaterThan(0);

    const gc = grantClient();
    for (const emp of emps) {
      const served = await resolveServedCapabilities(emp, { client: gc, control: "legacy" });
      const legacy = resolveEmployeeCapabilities(emp);
      // Rolled back: the served set IS the legacy resolution (tokens AND source), and the
      // registry is never the served source even though the control still consults it as a
      // shadow.
      expect(served.source, `${emp.slug}: rollback served the registry`).not.toBe("registry");
      expect(served.source).toBe(legacy.source);
      expect([...served.tokens], `${emp.slug}: rollback tokens drift`).toEqual([...legacy.tokens]);
    }
  });

  it("FAIL-SAFE — under registry authority, a subject the registry is silent about is served its retained legacy capabilities (never stranded)", async () => {
    // A synthetic employee with NO registry grant (a backfill gap). SAFE_KEY-clean so the
    // resolver issues the employee-scope query; the flat mirror means no global/department
    // grant catches it, so the registry is silent (source "none").
    const phantom: LegacyEmployee = {
      slug: "r4_phantom_no_grant",
      department: null,
      tools_allowed: ["tasks.read", "memory.read"],
      permissions: { scopes: ["comms.send"] },
      memory_scope: null,
    };

    // Precondition: the registry really is silent for the phantom (pins the fail-safe
    // scenario — if global/department authoring later catches it, this fails loudly).
    const registry = await resolveAuthorityFromRegistry(grantClient(), {
      slug: phantom.slug,
      department: phantom.department,
    });
    expect(registry.source, "phantom must have no applicable grant").toBe("none");

    // Registry authoritative, yet the phantom is served its legacy capabilities, not stranded.
    const served = await resolveServedCapabilities(phantom, {
      client: grantClient(),
      control: "registry",
    });
    const legacy = resolveEmployeeCapabilities(phantom);
    expect(served.source, "a silent registry must fall back to legacy").toBe(legacy.source);
    expect(served.source).toBe("ai_employees");
    expect([...served.tokens]).toEqual([...legacy.tokens]);
    expect(served.tokens.length, "the phantom keeps its own tokens").toBeGreaterThan(0);
  });

  it("REGISTRY IS AUTHORITATIVE — an out-of-band divergence is SERVED from the registry (monitored, not a fallback)", async () => {
    const emps = [...(await roster())].sort((a, b) => a.slug.localeCompare(b.slug));
    const sample = emps[0];
    expect(sample, "need a sampled employee to break").toBeDefined();
    if (!sample) return;

    const before = await resolveServedCapabilities(sample, {
      client: grantClient(),
      control: "registry",
    });
    expect(before.source).toBe("registry");
    expect(before.tokens.length, "need a token to drop").toBeGreaterThan(0);
    const original = [...before.tokens];

    // Break the employee grant out-of-band: drop one token (a permitted content edit).
    const broke = await svc()
      .from("hq_capability_grants")
      .update({ tokens: original.slice(1) })
      .eq("scope_level", "employee")
      .eq("scope_key", sample.slug);
    expect(broke.error, broke.error?.message).toBeNull();
    const afterBreak = await resolveServedCapabilities(sample, {
      client: grantClient(),
      control: "registry",
    });

    // Repair it BEFORE asserting, so the roster is always left back in parity.
    const repaired = await svc()
      .from("hq_capability_grants")
      .update({ tokens: original })
      .eq("scope_level", "employee")
      .eq("scope_key", sample.slug);
    expect(repaired.error, repaired.error?.message).toBeNull();
    const afterRepair = await resolveServedCapabilities(sample, {
      client: grantClient(),
      control: "registry",
    });

    // The diverged value is SERVED FROM THE REGISTRY — still source "registry" (not a legacy
    // fallback), carrying the broken (dropped-token) set, NOT the legacy set. That is the
    // registry being truly authoritative: divergence is monitored, not silently repaired.
    expect(afterBreak.source, "divergence must stay registry-served, not fall back").toBe(
      "registry",
    );
    expect(
      afterBreak.tokens.length,
      "the served set must be the broken registry value, not the legacy value",
    ).toBe(original.length - 1);
    const legacyTokens = resolveEmployeeCapabilities(sample).tokens;
    expect(
      afterBreak.tokens.length === legacyTokens.length,
      "served must differ from legacy while diverged",
    ).toBe(false);

    // After repair the served set is back in parity.
    expect(afterRepair.source).toBe("registry");
    expect([...afterRepair.tokens], "parity must be restored after repair").toEqual(original);
  });
});

/**
 * LR3 — the FULL served authority (resolveServedAuthority). R4 (above) switched TOKENS to the
 * registry; LR3 extends the switch to the last runtime reads R4 left on the legacy model —
 * POSTURE and MEMORY SCOPE — by serving every dimension from the ONE source the serving
 * decision chooses. These four tests prove the SAME four behaviours the R4 block proves for
 * tokens, now for tokens AND posture AND memory scope together:
 *
 *   1. SWITCH PRESERVES PARITY — every dimension is served from the registry and equals the
 *      legacy resolution (the flat mirror): behaviour-preserving at the cut.
 *   2. ROLLBACK SERVES LEGACY — control "legacy" serves the legacy resolution on every
 *      dimension and never the registry.
 *   3. FAIL-SAFE NEVER STRANDS — a subject the registry is silent about is served its retained
 *      legacy authority on every dimension.
 *   4. REGISTRY IS TRULY AUTHORITATIVE — an out-of-band posture + memory_scope divergence is
 *      SERVED from the registry (monitored, not silently repaired), proving the registry — not
 *      the legacy model — is the served source for the LR3 dimensions too.
 */
describeIntegration("Capability Registry · LR3 served authority — posture + memory scope (D-05)", () => {
  it("the switch serves EVERY dimension (tokens, posture, memory scope) from the REGISTRY, preserving parity for every employee", async () => {
    const emps = await roster();
    expect(emps.length, "the seeded roster must be present").toBeGreaterThan(0);

    const gc = grantClient();
    const drift: string[] = [];
    for (const emp of emps) {
      const served = await resolveServedAuthority(emp, { client: gc, control: "registry" });
      if (served.source !== "registry") {
        drift.push(`${emp.slug}: served ${served.source}, not registry`);
        continue;
      }
      // The legacy baseline in the comparable shape the serving decision itself compares
      // against — built from the canonical legacy resolvers (tokens + posture + memory scope).
      const legacy = legacyAuthorityOf(emp);
      const mismatch: string[] = [];
      const sameTokens =
        served.capabilities.tokens.length === legacy.tokens.length &&
        served.capabilities.tokens.every((t, i) => t === legacy.tokens[i]);
      if (!sameTokens) mismatch.push("tokens");
      if (served.posture.canExecute !== legacy.canExecute) mismatch.push("canExecute");
      if (served.posture.requiresApproval !== legacy.requiresApproval)
        mismatch.push("requiresApproval");
      if (served.memoryScope !== legacy.memoryScope) mismatch.push("memoryScope");
      if (mismatch.length) drift.push(`${emp.slug}: ${mismatch.join(", ")} diverge through the switch`);
    }
    expect(drift, `LR3 switch out of parity: ${drift.join(" | ")}`).toHaveLength(0);
  });

  it("ROLLBACK (control 'legacy') serves the legacy resolution on EVERY dimension and never the registry", async () => {
    const emps = await roster();
    expect(emps.length).toBeGreaterThan(0);

    const gc = grantClient();
    for (const emp of emps) {
      const served = await resolveServedAuthority(emp, { client: gc, control: "legacy" });
      const legacy = legacyAuthorityOf(emp);
      // Rolled back: every served dimension IS the legacy resolution, and the top-level source
      // is the legacy model (never the registry, even though the control still shadows it).
      expect(served.source, `${emp.slug}: rollback served the registry`).toBe("ai_employees");
      expect([...served.capabilities.tokens], `${emp.slug}: rollback tokens drift`).toEqual([
        ...legacy.tokens,
      ]);
      expect(served.posture.canExecute, `${emp.slug}: rollback canExecute drift`).toBe(
        legacy.canExecute,
      );
      expect(served.posture.requiresApproval, `${emp.slug}: rollback requiresApproval drift`).toBe(
        legacy.requiresApproval,
      );
      expect(served.memoryScope, `${emp.slug}: rollback memoryScope drift`).toBe(legacy.memoryScope);
    }
  });

  it("FAIL-SAFE — under registry authority, a subject the registry is silent about is served its retained legacy authority on EVERY dimension (never stranded)", async () => {
    // A synthetic employee with NO registry grant (a backfill gap). SAFE_KEY-clean so the
    // resolver issues the employee-scope query; the flat mirror means no global/department
    // grant catches it, so the registry is silent (source "none").
    const phantom: LegacyEmployee = {
      slug: "lr3_phantom_no_grant",
      department: null,
      tools_allowed: ["tasks.read", "memory.read"],
      permissions: { scopes: ["comms.send"] },
      memory_scope: null,
    };

    // Precondition: the registry really is silent for the phantom (pins the fail-safe scenario —
    // if global/department authoring later catches it, this fails loudly).
    const registry = await resolveAuthorityFromRegistry(grantClient(), {
      slug: phantom.slug,
      department: phantom.department,
    });
    expect(registry.source, "phantom must have no applicable grant").toBe("none");

    // Registry authoritative, yet the phantom is served its legacy authority on every dimension.
    const served = await resolveServedAuthority(phantom, {
      client: grantClient(),
      control: "registry",
    });
    const legacy = legacyAuthorityOf(phantom);
    expect(served.source, "a silent registry must fall back to legacy").toBe("ai_employees");
    expect([...served.capabilities.tokens]).toEqual([...legacy.tokens]);
    expect(served.posture.canExecute).toBe(legacy.canExecute);
    expect(served.posture.requiresApproval).toBe(legacy.requiresApproval);
    expect(served.memoryScope).toBe(legacy.memoryScope);
    expect(served.capabilities.tokens.length, "the phantom keeps its own tokens").toBeGreaterThan(0);
  });

  it("REGISTRY IS AUTHORITATIVE for the LR3 dimensions — an out-of-band posture + memory_scope divergence is SERVED from the registry (monitored, not a fallback)", async () => {
    const emps = [...(await roster())].sort((a, b) => a.slug.localeCompare(b.slug));
    const sample = emps[0];
    expect(sample, "need a sampled employee to break").toBeDefined();
    if (!sample) return;

    // Read the RAW employee grant first, so we can repair it to its EXACT original values.
    const grantRow = await svc()
      .from("hq_capability_grants")
      .select("memory_scope, can_execute")
      .eq("scope_level", "employee")
      .eq("scope_key", sample.slug);
    expect(grantRow.error, grantRow.error?.message).toBeNull();
    const row = (grantRow.data ?? [])[0];
    expect(row, "the sample must have an employee grant to perturb").toBeDefined();
    if (!row) return;
    const originalScope = (row.memory_scope as string | null) ?? null;
    const originalCanExecute = (row.can_execute as boolean | null) ?? null;

    const before = await resolveServedAuthority(sample, {
      client: grantClient(),
      control: "registry",
    });
    expect(before.source).toBe("registry");

    // Choose broken values that DIVERGE from what is served in parity: a valid-vocabulary scope
    // different from the current one, and the opposite execution stance.
    const brokeScope = before.memoryScope === "global" ? "isolated" : "global";
    const brokeExec = !before.posture.canExecute;

    const broke = await svc()
      .from("hq_capability_grants")
      .update({ memory_scope: brokeScope, can_execute: brokeExec })
      .eq("scope_level", "employee")
      .eq("scope_key", sample.slug);
    expect(broke.error, broke.error?.message).toBeNull();
    const afterBreak = await resolveServedAuthority(sample, {
      client: grantClient(),
      control: "registry",
    });

    // Repair to the EXACT originals BEFORE asserting, so the roster is always left in parity.
    const repaired = await svc()
      .from("hq_capability_grants")
      .update({ memory_scope: originalScope, can_execute: originalCanExecute })
      .eq("scope_level", "employee")
      .eq("scope_key", sample.slug);
    expect(repaired.error, repaired.error?.message).toBeNull();
    const afterRepair = await resolveServedAuthority(sample, {
      client: grantClient(),
      control: "registry",
    });

    // The diverged posture AND memory scope are SERVED FROM THE REGISTRY — still source
    // "registry" (not a legacy fallback), carrying the broken values, NOT the legacy values.
    // That is the registry being truly authoritative for the LR3 dimensions: divergence is
    // monitored, not silently repaired.
    const legacy = legacyAuthorityOf(sample);
    expect(afterBreak.source, "divergence must stay registry-served, not fall back").toBe(
      "registry",
    );
    expect(afterBreak.memoryScope, "the served scope must be the broken registry value").toBe(
      brokeScope,
    );
    expect(afterBreak.memoryScope, "served scope must differ from legacy while diverged").not.toBe(
      legacy.memoryScope,
    );
    expect(afterBreak.posture.canExecute, "the served posture must be the broken registry value").toBe(
      brokeExec,
    );
    expect(
      afterBreak.posture.canExecute,
      "served posture must differ from legacy while diverged",
    ).not.toBe(legacy.canExecute);

    // After repair every dimension is back in parity.
    expect(afterRepair.source).toBe("registry");
    expect(afterRepair.memoryScope, "memory scope parity must be restored after repair").toBe(
      before.memoryScope,
    );
    expect(afterRepair.posture.canExecute, "posture parity must be restored after repair").toBe(
      before.posture.canExecute,
    );
  });
});
