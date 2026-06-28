import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import {
  legacyAuthorityOf,
  resolveAuthorityFromRegistry,
  type GrantReadClient,
  type LegacyEmployee,
} from "@/server/sdk/registry-parity";
import { compareAuthority, type ResolvedAuthority } from "@/server/sdk/registry-resolver";

/**
 * The Capability Registry — R3 (runtime resolver) real-Postgres parity proof.
 *
 * CEO Directive #015 / D-05. ADR: docs/bible/decisions/0010-capability-registry.md
 * (Decision 5). Governing rule: the Behaviour Preservation Rule (Kernel Contract Map §2,
 * fifteenth standard) — "the runtime itself proves equivalence".
 *
 * The security tier pins R3's CONTRACT against its source text; this tier proves the
 * BEHAVIOUR that text can't: that the ACTUAL runtime resolver (resolveAuthorityFromRegistry
 * → composeGrants, the same code the SDK read path runs) resolves, for every live employee,
 * to the SAME authority as the canonical legacy model (legacyAuthorityOf) — the runtime
 * analogue of the R2 SQL parity gate. It also proves the runtime parity has TEETH (an
 * injected divergence is detected, then repaired) and that a JWT client is denied the
 * authority data by RLS:hq.
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

describeIntegration("Capability Registry · R3 runtime resolver parity (D-05)", () => {
  it("the runtime resolver resolves every employee to the SAME authority as the legacy model", async () => {
    const emps = await roster();
    expect(emps.length, "the seeded roster must be present").toBeGreaterThan(0);

    const gc = grantClient();
    const divergences: string[] = [];
    for (const emp of emps) {
      const registry = await resolveAuthorityFromRegistry(gc, {
        slug: emp.slug,
        department: emp.department,
      });
      // R2 backfilled an employee grant for every employee, so the resolver must compose
      // from the registry (not stand on the default-deny floor).
      expect(registry.source, `${emp.slug} resolved to the floor — no grant`).toBe("registry");

      const divergence = compareAuthority(legacyAuthorityOf(emp), registry);
      if (divergence) divergences.push(`${emp.slug}: ${divergence.dimensions.join(", ")}`);
    }
    expect(divergences, `runtime resolver out of parity: ${divergences.join(" | ")}`).toHaveLength(0);
  });

  it("the runtime parity has TEETH — an injected divergence is detected, then repaired", async () => {
    const emps = [...(await roster())].sort((a, b) => a.slug.localeCompare(b.slug));
    const sample = emps[0];
    expect(sample, "need a sampled employee to break").toBeDefined();
    if (!sample) return;

    const before = await resolveAuthorityFromRegistry(grantClient(), sample);
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
    const afterBreak = await resolveAuthorityFromRegistry(grantClient(), sample);
    const brokenDivergence = compareAuthority(legacyAuthorityOf(sample), afterBreak);

    // Repair it BEFORE asserting, so the roster is always left back in parity.
    const repaired = await svc()
      .from("hq_capability_grants")
      .update({ tokens: original })
      .eq("scope_level", "employee")
      .eq("scope_key", sample.slug);
    expect(repaired.error, repaired.error?.message).toBeNull();
    const afterRepair = await resolveAuthorityFromRegistry(grantClient(), sample);
    const repairedDivergence = compareAuthority(legacyAuthorityOf(sample), afterRepair);

    expect(brokenDivergence?.dimensions, "a dropped token must diverge on tokens").toContain("tokens");
    expect(repairedDivergence, "parity must be restored after repair").toBeNull();
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
