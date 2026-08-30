import { expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import {
  resolveAuthorityFromRegistry,
  resolveServedAuthority,
  resolveServedCapabilities,
  type GrantReadClient,
  type LegacyEmployee,
} from "@/server/sdk/registry-parity";

/**
 * The Capability Registry — R4 + LR3 (runtime authority switch) real-Postgres behaviour proof.
 *
 * CEO Directive #015 / D-05. ADR: docs/bible/decisions/0010-capability-registry.md
 * (Decision 5). Governing rules: the Behaviour Preservation Rule (Kernel Contract Map §2,
 * fifteenth standard), the Registry Completeness Rule (twentieth, whose SERVING clause LR3
 * advanced) and — this increment — the Data Removal Rule (26th) and the Legacy Independence
 * Rule (28th): LR5.4B removed the legacy authority columns, so the registry is the SOLE served
 * source and the automatic fail-safe is the default-deny FLOOR (there is no legacy model left
 * to fall back to or compare against).
 *
 * The security tier pins the CONTRACT against source text; this tier proves the BEHAVIOUR that
 * text can't — that the ACTUAL serve path (resolveServedCapabilities, the function the identity
 * assembly calls) behaves correctly against a live registry:
 *
 *   1. REGISTRY-SOLE — with the registry authoritative, every live employee is served the
 *      registry (`source: "registry"`): the backfilled roster resolves wholly from grants.
 *   2. FAIL-SAFE NEVER STRANDS — a subject the registry is silent about (no grant — a backfill
 *      gap) is served the default-deny FLOOR (`source: "floor"`, no tokens), the SAFE stance.
 *      LR5.4B replaced the former legacy fallback with the floor: a fail-safe can only ever
 *      grant LESS, never more, so an unauthored subject is DENIED, never stranded on stale data.
 *   3. REGISTRY IS TRULY AUTHORITATIVE — an out-of-band grant edit is SERVED from the registry
 *      (the LIVE value, read fresh, not a cache), proving the registry is the served source.
 *
 * The LR3 block below proves the SAME behaviours for the FULL served authority
 * (resolveServedAuthority) — extending the switch from tokens to posture AND memory scope.
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
  is(column: string, value: null): Filterable<T>;
  select(columns?: string): Filterable<T>;
};
type RegistryTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  update(patch: Record<string, unknown>): Filterable<null>;
};
type DbClient = { from(table: string): RegistryTable };

const svc = (): DbClient => serviceClient() as unknown as DbClient;
const grantClient = (): GrantReadClient => serviceClient() as unknown as GrantReadClient;
// LR5.4B dropped ai_employees.tools_allowed / permissions / memory_scope; the bridge reads only
// the subject's slug + department to query the registry (every authority dimension is served
// from the grant, with the default-deny floor as the fail-safe).
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
  const res = await svc().from("ai_employees").select(EMP_COLUMNS).is("retired_at", null);
  expect(res.error, res.error?.message).toBeNull();
  return ((res.data ?? []) as Record<string, unknown>[]).map(toLegacy);
}

describeIntegration("Capability Registry · R4 served-authority switch (D-05)", () => {
  it("the switch serves the REGISTRY as authoritative for every live employee", async () => {
    const emps = await roster();
    expect(emps.length, "the seeded roster must be present").toBeGreaterThan(0);

    const gc = grantClient();
    const drift: string[] = [];
    for (const emp of emps) {
      const served = await resolveServedCapabilities(emp, { client: gc });
      // The served source is the registry (the R4 transition, now the registry-SOLE end state):
      // the backfilled roster resolves wholly from grants, never the default-deny floor.
      if (served.source !== "registry") drift.push(`${emp.slug}: served ${served.source}, not registry`);
    }
    expect(drift, `served from the wrong source: ${drift.join(" | ")}`).toHaveLength(0);
  });

  it("FAIL-SAFE — a subject the registry is silent about is served the default-deny FLOOR (never stranded)", async () => {
    // A synthetic employee with NO registry grant (a backfill gap). SAFE_KEY-clean so the
    // resolver issues the employee-scope query; nothing catches it, so the registry is silent.
    const phantom: LegacyEmployee = { slug: "r4_phantom_no_grant", department: null };

    // Precondition: the registry really is silent for the phantom (pins the fail-safe scenario —
    // if global/department authoring later catches it, this fails loudly).
    const registry = await resolveAuthorityFromRegistry(grantClient(), {
      slug: phantom.slug,
      department: phantom.department,
    });
    expect(registry.source, "phantom must have no applicable grant").toBe("none");

    // A silent registry serves the default-deny FLOOR (LR5.4B replaced the legacy fallback): the
    // phantom is DENIED, not stranded on removed legacy authority. The tokens seam projects the
    // floor as EMPTY_CAPABILITIES — source "none", no tokens (the full ServedAuthority.source is
    // "floor"; the capabilities projection encodes the floor as "none", asserted on the LR3 dims).
    const served = await resolveServedCapabilities(phantom, { client: grantClient() });
    expect(served.source, "the floor projects as source 'none' at the tokens seam").toBe("none");
    expect([...served.tokens], "the floor grants no capabilities").toHaveLength(0);
  });

  it("REGISTRY IS AUTHORITATIVE — an out-of-band grant edit is SERVED from the registry (the live value)", async () => {
    const emps = [...(await roster())].sort((a, b) => a.slug.localeCompare(b.slug));
    const sample = emps[0];
    expect(sample, "need a sampled employee to break").toBeDefined();
    if (!sample) return;

    const before = await resolveServedCapabilities(sample, { client: grantClient() });
    expect(before.source).toBe("registry");
    expect(before.tokens.length, "need a token to drop").toBeGreaterThan(0);
    const original = [...before.tokens];
    const dropped = original[0]!;

    // Edit the employee grant out-of-band: drop one token (a permitted content edit).
    const broke = await svc()
      .from("hq_capability_grants")
      .update({ tokens: original.slice(1) })
      .eq("scope_level", "employee")
      .eq("scope_key", sample.slug);
    expect(broke.error, broke.error?.message).toBeNull();
    const afterBreak = await resolveServedCapabilities(sample, { client: grantClient() });

    // Repair it BEFORE asserting, so the roster is always left whole.
    const repaired = await svc()
      .from("hq_capability_grants")
      .update({ tokens: original })
      .eq("scope_level", "employee")
      .eq("scope_key", sample.slug);
    expect(repaired.error, repaired.error?.message).toBeNull();
    const afterRepair = await resolveServedCapabilities(sample, { client: grantClient() });

    // The served set is the LIVE registry value — still source "registry", carrying the edited
    // (dropped-token) set: the registry is truly authoritative, read fresh, not cached.
    expect(afterBreak.source, "the edit must stay registry-served").toBe("registry");
    expect(afterBreak.tokens, "the dropped token must vanish from the served set").not.toContain(dropped);
    expect(afterBreak.tokens.length, "the served set must be the edited registry value").toBe(
      original.length - 1,
    );

    // After repair the served set is back whole.
    expect(afterRepair.source).toBe("registry");
    expect([...afterRepair.tokens], "the served set must return after repair").toEqual(original);
  });
});

/**
 * LR3 — the FULL served authority (resolveServedAuthority). R4 (above) switched TOKENS to the
 * registry; LR3 extends the switch to the last runtime dimensions — POSTURE and MEMORY SCOPE —
 * by serving every dimension from the ONE source the serving decision chooses. These tests prove
 * the SAME behaviours the R4 block proves for tokens, now for tokens AND posture AND memory scope
 * together:
 *
 *   1. REGISTRY-SOLE — every dimension is served from the registry for every live employee, and
 *      the serve path FAITHFULLY projects what the pure resolver composes (no dimension dropped
 *      or re-sourced). The registry IS the authority — LR5.4B removed the legacy baseline.
 *   2. FAIL-SAFE NEVER STRANDS — a subject the registry is silent about is served the default-deny
 *      FLOOR on every dimension (no tokens, locked posture, isolated memory). LR5.4B replaced the
 *      legacy fallback with the floor (the safe stance).
 *   3. REGISTRY IS TRULY AUTHORITATIVE — an out-of-band posture + memory_scope edit is SERVED from
 *      the registry (the LIVE value), proving the registry is the served source for the LR3 dims.
 */
describeIntegration("Capability Registry · LR3 served authority — posture + memory scope (D-05)", () => {
  it("the switch serves EVERY dimension (tokens, posture, memory scope) from the REGISTRY for every employee", async () => {
    const emps = await roster();
    expect(emps.length, "the seeded roster must be present").toBeGreaterThan(0);

    const gc = grantClient();
    const drift: string[] = [];
    for (const emp of emps) {
      const served = await resolveServedAuthority(emp, { client: gc });
      if (served.source !== "registry") {
        drift.push(`${emp.slug}: served ${served.source}, not registry`);
        continue;
      }
      // The serve path must FAITHFULLY project what the pure resolver composes from the grants —
      // tokens, posture AND memory scope, all from the ONE registry source (no dimension dropped
      // or re-sourced). This is the registry-native replacement for the old legacy comparison.
      const resolved = await resolveAuthorityFromRegistry(gc, {
        slug: emp.slug,
        department: emp.department,
      });
      const mismatch: string[] = [];
      const sameTokens =
        served.capabilities.tokens.length === resolved.tokens.length &&
        served.capabilities.tokens.every((t, i) => t === resolved.tokens[i]);
      if (!sameTokens) mismatch.push("tokens");
      if (served.posture.canExecute !== resolved.canExecute) mismatch.push("canExecute");
      if (served.posture.requiresApproval !== resolved.requiresApproval) mismatch.push("requiresApproval");
      if (served.memoryScope !== resolved.memoryScope) mismatch.push("memoryScope");
      if (mismatch.length) drift.push(`${emp.slug}: ${mismatch.join(", ")}`);
    }
    expect(drift, `LR3 serve path dropped or altered a dimension: ${drift.join(" | ")}`).toHaveLength(0);
  });

  it("FAIL-SAFE — a subject the registry is silent about is served the default-deny FLOOR on EVERY dimension (never stranded)", async () => {
    // A synthetic employee with NO registry grant (a backfill gap). SAFE_KEY-clean so the
    // resolver issues the employee-scope query; nothing catches it, so the registry is silent.
    const phantom: LegacyEmployee = { slug: "lr3_phantom_no_grant", department: null };

    // Precondition: the registry really is silent for the phantom (pins the fail-safe scenario).
    const registry = await resolveAuthorityFromRegistry(grantClient(), {
      slug: phantom.slug,
      department: phantom.department,
    });
    expect(registry.source, "phantom must have no applicable grant").toBe("none");

    // A silent registry serves the default-deny FLOOR on every dimension (LR5.4B): no tokens, the
    // locked posture (can_execute=false, requires_approval=true) and the isolated memory floor.
    const served = await resolveServedAuthority(phantom, { client: grantClient() });
    expect(served.source, "a silent registry must serve the default-deny floor").toBe("floor");
    expect([...served.capabilities.tokens], "the floor grants no capabilities").toHaveLength(0);
    expect(served.posture.canExecute, "the floor posture cannot execute").toBe(false);
    expect(served.posture.requiresApproval, "the floor posture always requires approval").toBe(true);
    expect(served.memoryScope, "the floor memory scope is isolated").toBe("isolated");
  });

  it("REGISTRY IS AUTHORITATIVE for the LR3 dimensions — an out-of-band posture + memory_scope edit is SERVED from the registry (the live value)", async () => {
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

    const before = await resolveServedAuthority(sample, { client: grantClient() });
    expect(before.source).toBe("registry");

    // Choose broken values that DIFFER from what is served now: a valid-vocabulary scope
    // different from the current one, and the opposite execution stance.
    const brokeScope = before.memoryScope === "global" ? "isolated" : "global";
    const brokeExec = !before.posture.canExecute;

    const broke = await svc()
      .from("hq_capability_grants")
      .update({ memory_scope: brokeScope, can_execute: brokeExec })
      .eq("scope_level", "employee")
      .eq("scope_key", sample.slug);
    expect(broke.error, broke.error?.message).toBeNull();
    const afterBreak = await resolveServedAuthority(sample, { client: grantClient() });

    // Repair to the EXACT originals BEFORE asserting, so the roster is always left whole.
    const repaired = await svc()
      .from("hq_capability_grants")
      .update({ memory_scope: originalScope, can_execute: originalCanExecute })
      .eq("scope_level", "employee")
      .eq("scope_key", sample.slug);
    expect(repaired.error, repaired.error?.message).toBeNull();
    const afterRepair = await resolveServedAuthority(sample, { client: grantClient() });

    // The edited posture AND memory scope are SERVED FROM THE REGISTRY — still source "registry",
    // carrying the LIVE (edited) values: the registry is truly authoritative for the LR3 dims,
    // read fresh, not cached.
    expect(afterBreak.source, "the edit must stay registry-served").toBe("registry");
    expect(afterBreak.memoryScope, "the served scope must be the edited registry value").toBe(brokeScope);
    expect(afterBreak.posture.canExecute, "the served posture must be the edited registry value").toBe(brokeExec);

    // After repair every dimension is back to the original served value.
    expect(afterRepair.source).toBe("registry");
    expect(afterRepair.memoryScope, "memory scope must be restored after repair").toBe(before.memoryScope);
    expect(afterRepair.posture.canExecute, "posture must be restored after repair").toBe(before.posture.canExecute);
  });
});
