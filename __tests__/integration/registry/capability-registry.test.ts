import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * The Capability Registry — R1 (Registry Schema) real-Postgres proof.
 *
 * CEO Directive #015 / D-05. ADR: docs/bible/decisions/0010-capability-registry.md.
 *
 * The security tier pins the migration's CONTRACT against its source text; this
 * tier proves the BEHAVIOUR that text can't ("mocks prove intent; real
 * infrastructure proves behaviour"): that RLS:hq actually denies anon, that the
 * default-deny posture floor is the real column default, that token referential
 * integrity, the per-scope uniqueness, the scope/registration constraints, and the
 * immutable-audit guard actually reject the writes they must — in a live database.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no
 * database, FAILED loudly in CI if the database is missing.
 *
 * hq_capabilities / hq_capability_grants are service-role-only HQ internals not in
 * the generated Database types, so — like the spine suite — the typed client is
 * cast to the minimal surface exercised here rather than reaching for `any`.
 */

type QueryResult<T> = { data: T | null; error: { message: string } | null };
type Term<T> = PromiseLike<QueryResult<T>>;
type Filterable<T> = Term<T> & {
  eq(column: string, value: unknown): Filterable<T>;
  select(columns?: string): Filterable<T>;
  single(): Term<Record<string, unknown>>;
};
type RegistryTable = {
  select(columns?: string): Filterable<Record<string, unknown>[]>;
  insert(row: Record<string, unknown> | Record<string, unknown>[]): Filterable<Record<string, unknown>[]>;
  update(patch: Record<string, unknown>): Filterable<null>;
  delete(): Filterable<null>;
};
type RegistryClient = { from(table: string): RegistryTable };

const svc = (): RegistryClient => serviceClient() as unknown as RegistryClient;
const anon = (): RegistryClient => anonClient() as unknown as RegistryClient;

const rand = () => Math.random().toString(36).slice(2, 10);
const mkToken = () => `it.cap.${rand()}`;
const mkSlug = () => `it-emp-${rand()}`;

/** Define a capability token; returns it. Caller is responsible for cleanup. */
async function defineCapability(token: string): Promise<void> {
  const res = await svc().from("hq_capabilities").insert({ token });
  expect(res.error, res.error?.message).toBeNull();
}

/** Remove grants + capabilities created by a test (grants first — FK-like order). */
async function cleanup(opts: { slugs?: string[]; tokens?: string[]; globals?: boolean }) {
  for (const slug of opts.slugs ?? []) {
    await svc().from("hq_capability_grants").delete().eq("scope_key", slug);
  }
  if (opts.globals) {
    await svc().from("hq_capability_grants").delete().eq("scope_level", "global");
  }
  for (const token of opts.tokens ?? []) {
    await svc().from("hq_capabilities").delete().eq("token", token);
  }
}

describeIntegration("Capability Registry · R1 schema (D-05)", () => {
  it("anon cannot read hq_capabilities or hq_capability_grants — RLS:hq denies every JWT client", async () => {
    const token = mkToken();
    const slug = mkSlug();
    await defineCapability(token);
    const grant = await svc()
      .from("hq_capability_grants")
      .insert({ scope_level: "employee", scope_key: slug, tokens: [token] });
    expect(grant.error, grant.error?.message).toBeNull();

    // service_role (BYPASSRLS) sees both…
    const capAsService = await svc().from("hq_capabilities").select("token").eq("token", token);
    expect(capAsService.data).toHaveLength(1);
    const grantAsService = await svc()
      .from("hq_capability_grants")
      .select("id")
      .eq("scope_key", slug);
    expect(grantAsService.data).toHaveLength(1);

    // …anon sees nothing (hard error or RLS-filtered empty set — both are denial).
    const capAsAnon = await anon().from("hq_capabilities").select("token").eq("token", token);
    if (!capAsAnon.error) expect(capAsAnon.data ?? []).toHaveLength(0);
    const grantAsAnon = await anon().from("hq_capability_grants").select("id").eq("scope_key", slug);
    if (!grantAsAnon.error) expect(grantAsAnon.data ?? []).toHaveLength(0);

    await cleanup({ slugs: [slug], tokens: [token] });
  });

  it("a fresh grant defaults to the locked posture floor (can_execute=false, requires_approval=true, no tokens)", async () => {
    const slug = mkSlug();
    const inserted = await svc()
      .from("hq_capability_grants")
      .insert({ scope_level: "employee", scope_key: slug })
      .select("can_execute, requires_approval, tokens, memory_scope")
      .single();
    expect(inserted.error, inserted.error?.message).toBeNull();
    const row = inserted.data as Record<string, unknown>;
    expect(row.can_execute).toBe(false);
    expect(row.requires_approval).toBe(true);
    expect(row.tokens).toEqual([]);
    expect(row.memory_scope).toBe("isolated");

    await cleanup({ slugs: [slug] });
  });

  it("rejects a grant token that is not defined in the catalogue (referential integrity)", async () => {
    const slug = mkSlug();
    const res = await svc()
      .from("hq_capability_grants")
      .insert({ scope_level: "employee", scope_key: slug, tokens: ["never.defined"] });
    expect(res.error, "an undefined token must be rejected").not.toBeNull();

    await cleanup({ slugs: [slug] });
  });

  it("normalises stored tokens to sorted-distinct", async () => {
    const slug = mkSlug();
    const a = mkToken();
    const b = mkToken();
    // Ensure a deterministic expected order regardless of random suffixes.
    const [lo, hi] = [a, b].sort();
    await defineCapability(a);
    await defineCapability(b);

    const inserted = await svc()
      .from("hq_capability_grants")
      .insert({ scope_level: "employee", scope_key: slug, tokens: [hi, lo, hi] })
      .select("tokens")
      .single();
    expect(inserted.error, inserted.error?.message).toBeNull();
    expect((inserted.data as Record<string, unknown>).tokens).toEqual([lo, hi]);

    await cleanup({ slugs: [slug], tokens: [a, b] });
  });

  it("enforces one grant per scope — a second global and a duplicate (level,key) are rejected", async () => {
    // Global singleton.
    const g1 = await svc().from("hq_capability_grants").insert({ scope_level: "global" });
    expect(g1.error, g1.error?.message).toBeNull();
    const g2 = await svc().from("hq_capability_grants").insert({ scope_level: "global" });
    expect(g2.error, "a second global grant must be rejected").not.toBeNull();

    // Per-(level,key) uniqueness.
    const slug = mkSlug();
    const e1 = await svc()
      .from("hq_capability_grants")
      .insert({ scope_level: "employee", scope_key: slug });
    expect(e1.error, e1.error?.message).toBeNull();
    const e2 = await svc()
      .from("hq_capability_grants")
      .insert({ scope_level: "employee", scope_key: slug });
    expect(e2.error, "a duplicate (scope_level, scope_key) must be rejected").not.toBeNull();

    await cleanup({ slugs: [slug], globals: true });
  });

  it("enforces scope-key shape, the department vocabulary, and registration confinement", async () => {
    // global must carry no scope_key.
    const badGlobal = await svc()
      .from("hq_capability_grants")
      .insert({ scope_level: "global", scope_key: "oops" });
    expect(badGlobal.error, "global must not carry a scope_key").not.toBeNull();

    // a department key must be a known department.
    const badDept = await svc()
      .from("hq_capability_grants")
      .insert({ scope_level: "department", scope_key: "not-a-department" });
    expect(badDept.error, "an unknown department must be rejected").not.toBeNull();

    // registration metadata is confined to the employee scope.
    const badReg = await svc()
      .from("hq_capability_grants")
      .insert({ scope_level: "department", scope_key: "sales", registration: { cron: true } });
    expect(badReg.error, "registration outside the employee scope must be rejected").not.toBeNull();

    // a valid department grant (no registration) succeeds.
    const okDept = await svc()
      .from("hq_capability_grants")
      .insert({ scope_level: "department", scope_key: "sales" });
    expect(okDept.error, okDept.error?.message).toBeNull();

    await svc().from("hq_capability_grants").delete().eq("scope_key", "sales");
  });

  it("freezes the audit trail and scope identity on UPDATE, but allows content edits", async () => {
    const slug = mkSlug();
    const inserted = await svc()
      .from("hq_capability_grants")
      .insert({ scope_level: "employee", scope_key: slug })
      .select("id, created_at")
      .single();
    expect(inserted.error, inserted.error?.message).toBeNull();
    const row = inserted.data as Record<string, unknown>;

    // created_at is immutable.
    const auditEdit = await svc()
      .from("hq_capability_grants")
      .update({ created_at: "2000-01-01T00:00:00Z" })
      .eq("id", row.id);
    expect(auditEdit.error, "created_at must be immutable").not.toBeNull();

    // scope identity is immutable.
    const scopeEdit = await svc()
      .from("hq_capability_grants")
      .update({ scope_level: "global", scope_key: null })
      .eq("id", row.id);
    expect(scopeEdit.error, "scope identity must be immutable").not.toBeNull();

    // a legitimate content edit (out-of-band administration) is allowed.
    const contentEdit = await svc()
      .from("hq_capability_grants")
      .update({ requires_approval: true, can_execute: false })
      .eq("id", row.id);
    expect(contentEdit.error, contentEdit.error?.message).toBeNull();

    await cleanup({ slugs: [slug] });
  });

  it("blocks deleting a capability that a grant still references; allows it once unreferenced", async () => {
    const slug = mkSlug();
    const token = mkToken();
    await defineCapability(token);
    const grant = await svc()
      .from("hq_capability_grants")
      .insert({ scope_level: "employee", scope_key: slug, tokens: [token] });
    expect(grant.error, grant.error?.message).toBeNull();

    // Referenced → delete blocked.
    const blocked = await svc().from("hq_capabilities").delete().eq("token", token);
    expect(blocked.error, "a referenced capability must not be deletable").not.toBeNull();

    // Remove the grant, then the capability deletes cleanly.
    await svc().from("hq_capability_grants").delete().eq("scope_key", slug);
    const ok = await svc().from("hq_capabilities").delete().eq("token", token);
    expect(ok.error, ok.error?.message).toBeNull();
  });

  it("makes a defined capability token immutable (no silent rename)", async () => {
    const token = mkToken();
    await defineCapability(token);
    const renamed = await svc()
      .from("hq_capabilities")
      .update({ token: mkToken() })
      .eq("token", token);
    expect(renamed.error, "a capability token must be immutable").not.toBeNull();

    await cleanup({ tokens: [token] });
  });
});
