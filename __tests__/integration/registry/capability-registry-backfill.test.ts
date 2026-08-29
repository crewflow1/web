import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * The Capability Registry — R2 (Backfill) real-Postgres proof, at the registry-SOLE end state.
 *
 * CEO Directive #015 / D-05. ADR: docs/bible/decisions/0010-capability-registry.md
 * (Decision 10). Governing rule: the Migration Parity Rule (Kernel Contract Map §2) and —
 * this increment (LR5.4B, the FINAL removal) — the Data Removal Rule (26th) and the Legacy
 * Independence Rule (28th).
 *
 * The R2 backfill created one employee-scoped grant per live employee and defined every token
 * in the catalogue. The security tier pins the migration's CONTRACT against its source text;
 * this tier proves the BEHAVIOUR that text can't ("mocks prove intent; real infrastructure
 * proves behaviour"): that the backfill is COMPLETE (every employee has a grant), that the
 * catalogue is REFERENTIALLY COMPLETE (every token any grant holds is defined), and that the
 * grants are protected by RLS:hq (a JWT client reads nothing) — in a live database with every
 * migration applied.
 *
 * THE ORACLE IS RETIRED. R2 originally shipped a parity oracle (hq_capability_registry_parity)
 * that compared the registry grant to the legacy ai_employees authority columns. LR5.4B removed
 * the legacy columns and dropped the oracle (there is no baseline left to compare against), so
 * the former legacy-vs-registry parity sweep is retired: the registry is the SOLE authority, and
 * what remains to prove is that the backfill is whole and the catalogue covers it. (That the
 * runtime resolver reads these grants faithfully is proven in capability-resolver-parity.test.ts.)
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database,
 * FAILED loudly in CI if the database is missing.
 *
 * ai_employees / hq_capabilities / hq_capability_grants are service-role-only HQ internals not
 * in the generated Database types, so — like the R1 suite — the typed client is cast to the
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
};
type DbClient = { from(table: string): RegistryTable };

const svc = (): DbClient => serviceClient() as unknown as DbClient;
const anon = (): DbClient => anonClient() as unknown as DbClient;

describeIntegration("Capability Registry · R2 backfill — complete + referentially whole (D-05)", () => {
  it("the backfill is COMPLETE — every live employee has an employee-scoped grant", async () => {
    const emps = await svc().from("ai_employees").select("slug").is("retired_at", null);
    expect(emps.error, emps.error?.message).toBeNull();
    const slugs = ((emps.data ?? []) as Array<Record<string, unknown>>).map((r) => r.slug as string);
    expect(slugs.length, "the seeded roster must be present").toBeGreaterThan(0);

    const grants = await svc()
      .from("hq_capability_grants")
      .select("scope_level, scope_key");
    expect(grants.error, grants.error?.message).toBeNull();
    const employeeGrantKeys = new Set(
      ((grants.data ?? []) as Array<Record<string, unknown>>)
        .filter((g) => g.scope_level === "employee")
        .map((g) => g.scope_key as string),
    );

    const stranded = slugs.filter((s) => !employeeGrantKeys.has(s));
    expect(stranded, `employees with no backfilled grant: ${stranded.join(", ")}`).toHaveLength(0);
  });

  it("the catalogue defines every token any grant holds (referential completeness)", async () => {
    const grants = await svc().from("hq_capability_grants").select("tokens");
    expect(grants.error, grants.error?.message).toBeNull();

    const held = new Set<string>();
    for (const g of (grants.data ?? []) as Array<Record<string, unknown>>) {
      for (const t of (g.tokens as string[] | null) ?? []) if (t) held.add(t);
    }
    expect(held.size, "the backfilled grants must hold at least one token").toBeGreaterThan(0);

    const caps = await svc().from("hq_capabilities").select("token");
    expect(caps.error, caps.error?.message).toBeNull();
    const defined = new Set(
      ((caps.data ?? []) as Array<Record<string, unknown>>).map((r) => r.token as string),
    );

    const missing = [...held].filter((t) => !defined.has(t));
    expect(missing, `held but undefined: ${missing.join(", ")}`).toHaveLength(0);
  });

  it("anon cannot read the registry grants (RLS:hq returns no rows to a JWT client)", async () => {
    // hq_capability_grants is RLS:hq with zero policies for a JWT client: a select yields an
    // empty set (or a hard permission error) — both are denial. No JWT caller reads authority.
    const res = await anon().from("hq_capability_grants").select("scope_level, scope_key, tokens");
    if (!res.error) expect(res.data ?? []).toHaveLength(0);
  });
});
