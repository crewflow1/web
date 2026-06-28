import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * The Capability Registry — LR2 (Registry-Native Memory Scope) real-Postgres proof.
 *
 * CEO Directive #015 / D-05, Legacy Removal increment 2. ADR:
 * docs/bible/decisions/0010-capability-registry.md.
 *
 * The security tier pins LR2's CONTRACT against source text; this tier proves the
 * BEHAVIOUR that text can't ("mocks prove intent; real infrastructure proves
 * behaviour"): that the atomic memory-scope authoring RPC actually upserts the grant's
 * memory_scope, mirrors it deterministically to the legacy column, PRESERVES tokens +
 * posture, and leaves the employee in parity — checked against the platform's OWN parity
 * oracle (hq_capability_registry_parity) — and that the service-role lockdown actually
 * denies anon, in a live database.
 *
 * This is the increment that REPAIRS the latent drift the old direct-write path opened:
 * the parity oracle compares grant.memory_scope to ai_employees.memory_scope, and LR2
 * keeps them equal by construction (the Mirror Integrity Rule).
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no database,
 * FAILED loudly in CI if the database is missing.
 *
 * hq_* registry tables + ai_employees writes go through the service-role client cast to
 * the minimal surface exercised here, and the RPCs through a thin .rpc() cast — the LR1
 * suite's pattern — rather than reaching for `any`.
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
type RpcFn = (
  fn: string,
  args?: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

const svc = (): RegistryClient => serviceClient() as unknown as RegistryClient;

const rand = () => Math.random().toString(36).slice(2, 10);
const mkToken = () => `it.cap.${rand()}`;
const mkSlug = () => `it-emp-${rand()}`;

type AuthorArgs = {
  p_slug: string;
  p_memory_scope: string;
  p_actor_id?: string | null;
  p_actor_email?: string | null;
};

/** Call the memory-scope authoring RPC as the service role (or anon, to prove lockdown). */
function author(args: AuthorArgs, role: "svc" | "anon" = "svc") {
  const client = (role === "svc" ? serviceClient() : anonClient()) as unknown as { rpc: RpcFn };
  return client.rpc("hq_author_employee_memory_scope", args);
}

/** The parity oracle's row for one employee (or undefined if absent). */
async function parityOf(slug: string): Promise<Record<string, unknown> | undefined> {
  const client = serviceClient() as unknown as { rpc: RpcFn };
  const { data, error } = await client.rpc("hq_capability_registry_parity");
  expect(error, error?.message).toBeNull();
  return (data as Record<string, unknown>[]).find((r) => r.slug === slug);
}

/** Create an ai_employee fixture; returns its id. */
async function createEmployee(
  slug: string,
  opts: { tools_allowed?: string[]; permissions?: Record<string, unknown>; memory_scope?: string } = {},
): Promise<string> {
  const res = await svc()
    .from("ai_employees")
    .insert({
      name: `IT ${slug}`,
      slug,
      role: "Integration fixture",
      department: "engineering",
      tools_allowed: opts.tools_allowed ?? [],
      permissions: opts.permissions ?? { can_execute: false, requires_approval: true, scopes: [] },
      memory_scope: opts.memory_scope ?? "isolated",
    })
    .select("id")
    .single();
  expect(res.error, res.error?.message).toBeNull();
  return (res.data as Record<string, unknown>).id as string;
}

/** Remove grants + employees + capabilities a test made (grants/employees before tokens). */
async function cleanup(opts: { slugs?: string[]; tokens?: string[] }) {
  for (const slug of opts.slugs ?? []) {
    await svc().from("hq_capability_grants").delete().eq("scope_key", slug);
    await svc().from("ai_employees").delete().eq("slug", slug);
  }
  for (const token of opts.tokens ?? []) {
    await svc().from("hq_capabilities").delete().eq("token", token);
  }
}

describeIntegration("Capability Registry · LR2 registry-native memory scope (D-05)", () => {
  it("authors a fresh employee — creates the grant (seeded tokens+posture), mirrors, holds parity", async () => {
    const slug = mkSlug();
    const tTok = mkToken(); // a tool permission the employee already holds in legacy
    const sTok = mkToken(); // a scope the employee already holds in legacy
    // Born WITH legacy tokens, so we prove a fresh grant seeds the token union and that
    // the RPC defines those (already-held) tokens to keep the grant valid.
    await createEmployee(slug, {
      tools_allowed: [tTok],
      permissions: { can_execute: false, requires_approval: true, scopes: [sTok] },
      memory_scope: "isolated",
    });

    const res = await author({
      p_slug: slug,
      p_memory_scope: "department",
      p_actor_id: null,
      p_actor_email: "it@crewflow.uk",
    });
    expect(res.error, res.error?.message).toBeNull();
    const env = res.data as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.action).toBe("created"); // a post-backfill employee has no grant yet
    expect(env.memory_scope).toBe("department");

    const expectedTokens = [sTok, tTok].sort();

    // The grant holds the authored memory_scope, the seeded legacy token union, and the
    // legacy posture — born in parity.
    const grant = await svc()
      .from("hq_capability_grants")
      .select("tokens, can_execute, requires_approval, memory_scope")
      .eq("scope_key", slug)
      .single();
    expect(grant.error, grant.error?.message).toBeNull();
    const g = grant.data as Record<string, unknown>;
    expect(g.memory_scope).toBe("department");
    expect(g.tokens).toEqual(expectedTokens); // seeded from the legacy union
    expect(g.can_execute).toBe(false); // posture seeded from the locked legacy floor
    expect(g.requires_approval).toBe(true);

    // The legacy column is mirrored to the SAME value (deterministic mirror).
    const emp = await svc()
      .from("ai_employees")
      .select("memory_scope, tools_allowed, permissions")
      .eq("slug", slug)
      .single();
    expect(emp.error, emp.error?.message).toBeNull();
    const e = emp.data as Record<string, unknown>;
    expect(e.memory_scope).toBe("department");
    // Tokens + posture on the legacy side are untouched by memory-scope authoring.
    expect(e.tools_allowed).toEqual([tTok]);
    const perms = e.permissions as { scopes?: string[]; can_execute?: boolean; requires_approval?: boolean };
    expect((perms.scopes ?? []).sort()).toEqual([sTok]);
    expect(perms.can_execute).toBe(false);
    expect(perms.requires_approval).toBe(true);

    // PARITY: the platform's own oracle agrees the employee is in parity on all dims.
    const parity = await parityOf(slug);
    expect(parity?.parity_ok, JSON.stringify(parity)).toBe(true);
    expect(parity?.registry_memory_scope).toBe("department");
    expect(parity?.legacy_memory_scope).toBe("department");

    // The seeded tokens are now defined in the catalogue (so the grant is valid).
    const cat = await svc().from("hq_capabilities").select("token").eq("token", tTok);
    expect((cat.data ?? []).length).toBe(1);

    await cleanup({ slugs: [slug], tokens: [tTok, sTok] });
  });

  it("re-authoring moves the scope (update path), preserves tokens + a non-default posture, idempotent", async () => {
    const slug = mkSlug();
    // A distinctive posture LR2 must leave untouched across both authoring calls.
    await createEmployee(slug, {
      permissions: { can_execute: false, requires_approval: false, scopes: [] },
      memory_scope: "isolated",
    });

    const first = await author({ p_slug: slug, p_memory_scope: "department", p_actor_email: "it@crewflow.uk" });
    expect(first.error, first.error?.message).toBeNull();
    expect((first.data as Record<string, unknown>).action).toBe("created");

    const second = await author({ p_slug: slug, p_memory_scope: "global", p_actor_email: "it@crewflow.uk" });
    expect(second.error, second.error?.message).toBeNull();
    expect((second.data as Record<string, unknown>).action).toBe("updated");

    const grant = await svc()
      .from("hq_capability_grants")
      .select("tokens, can_execute, requires_approval, memory_scope")
      .eq("scope_key", slug)
      .single();
    const g = grant.data as Record<string, unknown>;
    expect(g.memory_scope).toBe("global"); // the scope MOVED
    expect(g.tokens).toEqual([]); // tokens preserved (none) across the memory-scope write
    expect(g.can_execute).toBe(false);
    expect(g.requires_approval).toBe(false); // the non-default posture survived

    const emp = await svc().from("ai_employees").select("memory_scope, permissions").eq("slug", slug).single();
    const e = emp.data as Record<string, unknown>;
    expect(e.memory_scope).toBe("global");
    const perms = e.permissions as { can_execute?: boolean; requires_approval?: boolean };
    expect(perms.can_execute).toBe(false);
    expect(perms.requires_approval).toBe(false); // the legacy posture is untouched

    let parity = await parityOf(slug);
    expect(parity?.parity_ok, JSON.stringify(parity)).toBe(true);

    // Reproducible: re-authoring the SAME value is an idempotent update that holds parity.
    const again = await author({ p_slug: slug, p_memory_scope: "global", p_actor_email: "it@crewflow.uk" });
    expect((again.data as Record<string, unknown>).action).toBe("updated");
    parity = await parityOf(slug);
    expect(parity?.parity_ok, JSON.stringify(parity)).toBe(true);

    await cleanup({ slugs: [slug] });
  });

  it("an unknown employee is rejected with a clean envelope and NO grant side effect", async () => {
    const ghost = mkSlug();
    const res = await author({ p_slug: ghost, p_memory_scope: "department", p_actor_email: "it@crewflow.uk" });
    expect(res.error, res.error?.message).toBeNull();
    const env = res.data as Record<string, unknown>;
    expect(env.ok).toBe(false);
    expect(env.reason).toBe("unknown_employee");

    const grant = await svc().from("hq_capability_grants").select("id").eq("scope_key", ghost);
    expect(grant.data ?? []).toHaveLength(0);
  });

  it("a malformed memory scope is rejected with a clean envelope and NO write", async () => {
    const slug = mkSlug();
    await createEmployee(slug, { memory_scope: "isolated" });
    const res = await author({ p_slug: slug, p_memory_scope: "teleport", p_actor_email: "it@crewflow.uk" });
    expect(res.error, res.error?.message).toBeNull();
    const env = res.data as Record<string, unknown>;
    expect(env.ok).toBe(false);
    expect(env.reason).toBe("invalid_memory_scope");

    // The vocabulary check precedes every write — no grant created, legacy untouched.
    const grant = await svc().from("hq_capability_grants").select("id").eq("scope_key", slug);
    expect(grant.data ?? []).toHaveLength(0);
    const emp = await svc().from("ai_employees").select("memory_scope").eq("slug", slug).single();
    expect((emp.data as Record<string, unknown>).memory_scope).toBe("isolated");

    await cleanup({ slugs: [slug] });
  });

  it("anon cannot execute the memory-scope authoring RPC — EXECUTE is service-role only", async () => {
    const res = await author({ p_slug: mkSlug(), p_memory_scope: "isolated" }, "anon");
    expect(res.error, "anon must be denied EXECUTE on the memory-scope authoring RPC").not.toBeNull();
  });
});
