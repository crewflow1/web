import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * The Capability Registry — R2 (Backfill + Parity Gate) real-Postgres proof.
 *
 * CEO Directive #015 / D-05. ADR: docs/bible/decisions/0010-capability-registry.md
 * (Decision 10). Governing rule: the Migration Parity Rule (Kernel Contract Map §2).
 *
 * The security tier pins the migration's CONTRACT against its source text; this tier
 * proves the BEHAVIOUR that text can't ("mocks prove intent; real infrastructure
 * proves behaviour"): that the backfill actually achieved PARITY — that for every live
 * employee the registry resolves to the SAME authority as the legacy model — that the
 * catalogue actually defines every token in use, that the parity check actually has
 * TEETH (a divergent grant is detected), and that the parity function actually denies
 * a JWT client — in a live database with the migration applied.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database,
 * FAILED loudly in CI if the database is missing.
 *
 * ai_employees / hq_capabilities / hq_capability_grants and the parity function are
 * service-role-only HQ internals not in the generated Database types, so — like the R1
 * suite — the typed client is cast to the minimal surface exercised here.
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
type RpcClient = {
  from(table: string): RegistryTable;
  rpc(fn: string): Filterable<Record<string, unknown>[]>;
};

const svc = (): RpcClient => serviceClient() as unknown as RpcClient;
const anon = (): RpcClient => anonClient() as unknown as RpcClient;

type ParityRow = {
  slug: string;
  has_grant: boolean;
  legacy_tokens: string[] | null;
  registry_tokens: string[] | null;
  parity_ok: boolean;
};

/** Call the parity function and return its rows (service role; asserts no error). */
async function parityRows(client: RpcClient): Promise<ParityRow[]> {
  const res = await client.rpc("hq_capability_registry_parity");
  expect(res.error, res.error?.message).toBeNull();
  return (res.data ?? []) as unknown as ParityRow[];
}

describeIntegration("Capability Registry · R2 backfill + parity (D-05)", () => {
  it("every employee in the legacy roster is in parity with the registry", async () => {
    const rows = await parityRows(svc());
    expect(rows.length, "the seeded roster must be present").toBeGreaterThan(0);

    // The mirror is complete: one parity row per live employee, none missing a grant.
    const emps = await svc().from("ai_employees").select("slug");
    expect(emps.error, emps.error?.message).toBeNull();
    expect(rows.length).toBe((emps.data ?? []).length);
    for (const r of rows) expect(r.has_grant, `${r.slug} has no grant`).toBe(true);

    // And the registry resolves to the SAME authority as the legacy model, for all.
    const failing = rows.filter((r) => !r.parity_ok).map((r) => r.slug);
    expect(failing, `out of parity: ${failing.join(", ")}`).toHaveLength(0);
  });

  it("the catalogue defines every token any employee holds (referential completeness)", async () => {
    const emps = await svc().from("ai_employees").select("tools_allowed, permissions");
    expect(emps.error, emps.error?.message).toBeNull();

    const held = new Set<string>();
    for (const e of (emps.data ?? []) as Array<Record<string, unknown>>) {
      for (const t of (e.tools_allowed as string[] | null) ?? []) if (t) held.add(t);
      const perms = (e.permissions as { scopes?: string[] } | null) ?? {};
      for (const s of perms.scopes ?? []) if (s) held.add(s);
    }
    expect(held.size, "the roster must hold at least one token").toBeGreaterThan(0);

    const caps = await svc().from("hq_capabilities").select("token");
    expect(caps.error, caps.error?.message).toBeNull();
    const defined = new Set(
      ((caps.data ?? []) as Array<Record<string, unknown>>).map((r) => r.token as string),
    );

    const missing = [...held].filter((t) => !defined.has(t));
    expect(missing, `held but undefined: ${missing.join(", ")}`).toHaveLength(0);
  });

  it("the parity check has TEETH — a divergent grant is detected, then repaired", async () => {
    const rows = await parityRows(svc());
    expect(rows.length).toBeGreaterThan(0);
    const sample = [...rows].sort((a, b) => a.slug.localeCompare(b.slug))[0];
    expect(sample, "need a sampled grant to break").toBeDefined();
    if (!sample) return;
    const original = sample.registry_tokens ?? [];
    expect(original.length, "need a token to drop").toBeGreaterThan(0);

    // Break it: drop one token (a permitted out-of-band content edit).
    const broke = await svc()
      .from("hq_capability_grants")
      .update({ tokens: original.slice(1) })
      .eq("scope_level", "employee")
      .eq("scope_key", sample.slug);
    expect(broke.error, broke.error?.message).toBeNull();
    const afterBreak = (await parityRows(svc())).find((r) => r.slug === sample.slug);

    // Repair it BEFORE asserting, so the roster is always left back in parity.
    const repaired = await svc()
      .from("hq_capability_grants")
      .update({ tokens: original })
      .eq("scope_level", "employee")
      .eq("scope_key", sample.slug);
    expect(repaired.error, repaired.error?.message).toBeNull();
    const afterRepair = (await parityRows(svc())).find((r) => r.slug === sample.slug);

    expect(afterBreak?.parity_ok, "a divergent grant must fail parity").toBe(false);
    expect(afterRepair?.parity_ok, "parity must be restored after repair").toBe(true);
  });

  it("anon cannot read authority through the parity function (RLS:hq via SECURITY INVOKER)", async () => {
    // The function is SECURITY INVOKER, so it inherits the caller's RLS: a JWT client
    // sees no rows in the underlying RLS:hq tables, so the function yields nothing
    // (hard error or empty set — both are denial).
    const res = await anon().rpc("hq_capability_registry_parity");
    if (!res.error) expect(res.data ?? []).toHaveLength(0);
  });
});
