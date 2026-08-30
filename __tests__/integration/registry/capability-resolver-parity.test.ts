import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import {
  resolveAuthorityFromRegistry,
  type GrantReadClient,
  type LegacyEmployee,
} from "@/server/sdk/registry-parity";
import { type ResolvedAuthority } from "@/server/sdk/registry-resolver";

/**
 * The Capability Registry — R3 (runtime resolver) real-Postgres behaviour proof.
 *
 * CEO Directive #015 / D-05. ADR: docs/bible/decisions/0010-capability-registry.md
 * (Decision 5). Governing rule: the Behaviour Preservation Rule (Kernel Contract Map §2,
 * fifteenth standard) — "the runtime itself proves equivalence".
 *
 * The security tier pins R3's CONTRACT against its source text; this tier proves the
 * BEHAVIOUR that text can't: that the ACTUAL runtime resolver (resolveAuthorityFromRegistry
 * → composeGrants, the same code the SDK read path runs) resolves every live employee FROM
 * the registry (not the default-deny floor), reads the LIVE grant (an out-of-band edit is
 * reflected, then repaired), and is denied to a JWT client by RLS:hq. LR5.4B (the Data
 * Removal Rule, 26th §2 standard) removed the legacy authority columns and the
 * shadow-comparison machinery, so the former legacy-vs-registry parity proof is retired: the
 * registry is the SOLE authority, and what remains to prove is that the resolver reads it
 * faithfully and that RLS protects it.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database,
 * FAILED loudly in CI if the database is missing.
 *
 * ai_employees / hq_capability_grants are service-role-only HQ internals not in the
 * generated Database types, so — like the R1/R2 suites — the typed client is cast to the
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
// LR5.4B dropped ai_employees.tools_allowed / permissions / memory_scope; the resolver reads
// only the subject's slug + department to query the registry.
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

describeIntegration("Capability Registry · R3 runtime resolver — live-grant resolution (D-05)", () => {
  it("the runtime resolver resolves every live employee FROM the registry (not the floor)", async () => {
    const emps = await roster();
    expect(emps.length, "the seeded roster must be present").toBeGreaterThan(0);

    const gc = grantClient();
    const stranded: string[] = [];
    for (const emp of emps) {
      const registry = await resolveAuthorityFromRegistry(gc, {
        slug: emp.slug,
        department: emp.department,
      });
      // R2 backfilled an employee grant for every employee, so the resolver must compose
      // from the registry (not stand on the default-deny floor) — every live subject is
      // registry-sourced, the registry-SOLE end state LR5.4B leaves.
      if (registry.source !== "registry") stranded.push(emp.slug);
    }
    expect(stranded, `employees stranded on the default-deny floor: ${stranded.join(", ")}`).toHaveLength(0);
  });

  it("the runtime resolver reads the LIVE grant — an out-of-band edit is reflected, then repaired", async () => {
    const emps = [...(await roster())].sort((a, b) => a.slug.localeCompare(b.slug));
    const sample = emps[0];
    expect(sample, "need a sampled employee to break").toBeDefined();
    if (!sample) return;

    const before = await resolveAuthorityFromRegistry(grantClient(), sample);
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
    const afterBreak = await resolveAuthorityFromRegistry(grantClient(), sample);

    // Repair it BEFORE asserting, so the roster is always left whole.
    const repaired = await svc()
      .from("hq_capability_grants")
      .update({ tokens: original })
      .eq("scope_level", "employee")
      .eq("scope_key", sample.slug);
    expect(repaired.error, repaired.error?.message).toBeNull();
    const afterRepair = await resolveAuthorityFromRegistry(grantClient(), sample);

    // The resolver reflected the LIVE edit (the dropped token vanished from the resolved set)
    // and the repair (the original set returned) — it reads the grant, it does not cache it.
    expect(afterBreak.tokens, "a dropped grant token must vanish from the resolved set").not.toContain(dropped);
    expect([...afterRepair.tokens], "the resolved set must return after repair").toEqual(original);
  });

  it("anon cannot read authority through the runtime resolver (RLS:hq denies the JWT client)", async () => {
    // RLS:hq hides every grant row from a JWT client. The resolver then either sees an
    // empty set (→ the default-deny floor, source "none") or hits a hard permission error —
    // both are denial: a JWT caller can never resolve authority from the registry.
    let registry: ResolvedAuthority | null = null;
    let hardError = false;
    try {
      registry = await resolveAuthorityFromRegistry(anonClient() as unknown as GrantReadClient, {
        slug: "research-ai",
        department: "engineering",
      });
    } catch {
      hardError = true;
    }
    if (registry) {
      expect(registry.source).toBe("none");
      expect(registry.tokens).toHaveLength(0);
      expect(registry.canExecute).toBe(false);
    } else {
      expect(hardError).toBe(true);
    }
  });
});
