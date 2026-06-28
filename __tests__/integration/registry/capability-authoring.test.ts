import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * The Capability Registry — LR1 (Registry-Native Authoring) real-Postgres proof.
 *
 * CEO Directive #015 / D-05, Legacy Removal increment 1. ADR:
 * docs/bible/decisions/0010-capability-registry.md.
 *
 * The security tier pins LR1's CONTRACT against source text; this tier proves the
 * BEHAVIOUR that text can't ("mocks prove intent; real infrastructure proves
 * behaviour"): that the atomic authoring RPC actually defines tokens, writes the
 * employee grant, mirrors the parity-faithful split back to the legacy columns,
 * PRESERVES posture, and leaves the employee in parity — checked against the
 * platform's OWN parity oracle (hq_capability_registry_parity) — and that the
 * service-role lockdown actually denies anon, in a live database.
 *
 * Runs only against a live DB (describeIntegration): skipped locally with no
 * database, FAILED loudly in CI if the database is missing.
 *
 * hq_* registry tables + ai_employees writes go through the service-role client cast
 * to the minimal surface exercised here (the R1 suite's pattern), and the RPCs through
 * a thin .rpc() cast (the spine suite's pattern), rather than reaching for `any`.
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
  p_tokens: string[];
  p_actor_id?: string | null;
  p_actor_email?: string | null;
};

/** Call the authoring RPC as the service role (or anon, to prove the lockdown). */
function author(args: AuthorArgs, role: "svc" | "anon" = "svc") {
  const client = (role === "svc" ? serviceClient() : anonClient()) as unknown as { rpc: RpcFn };
  return client.rpc("hq_author_employee_capabilities", args);
}

/** The parity oracle's row for one employee (or undefined if absent). */
async function parityOf(slug: string): Promise<Record<string, unknown> | undefined> {
  const client = serviceClient() as unknown as { rpc: RpcFn };
  const { data, error } = await client.rpc("hq_capability_registry_parity");
  expect(error, error?.message).toBeNull();
  return (data as Record<string, unknown>[]).find((r) => r.slug === slug);
}

/** Define a capability token of a given kind; caller cleans it up. */
async function defineCapability(
  token: string,
  kind: "tool_permission" | "scope" = "tool_permission",
): Promise<void> {
  const res = await svc().from("hq_capabilities").insert({ token, kind });
  expect(res.error, res.error?.message).toBeNull();
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

describeIntegration("Capability Registry · LR1 registry-native authoring (D-05)", () => {
  it("authors a fresh employee — defines tokens, creates the grant, mirrors the kind split, holds parity", async () => {
    const slug = mkSlug();
    const tTok = mkToken(); // a tool permission (the RPC defines it as tool_permission)
    const sTok = mkToken(); // a scope (pre-defined with kind = 'scope')
    await createEmployee(slug);
    await defineCapability(sTok, "scope");

    const res = await author({
      p_slug: slug,
      p_tokens: [tTok, sTok, tTok], // unsorted + duplicate → normalised
      p_actor_id: null,
      p_actor_email: "it@crewflow.uk",
    });
    expect(res.error, res.error?.message).toBeNull();
    const env = res.data as Record<string, unknown>;
    expect(env.ok).toBe(true);
    expect(env.action).toBe("created"); // a post-backfill employee has no grant yet

    const expectedTokens = [sTok, tTok].sort();

    // The grant holds the sorted-distinct authored set at the employee scope.
    const grant = await svc()
      .from("hq_capability_grants")
      .select("tokens, can_execute, requires_approval, memory_scope")
      .eq("scope_key", slug)
      .single();
    expect(grant.error, grant.error?.message).toBeNull();
    const g = grant.data as Record<string, unknown>;
    expect(g.tokens).toEqual(expectedTokens);
    expect(g.can_execute).toBe(false); // posture seeded from the locked legacy floor
    expect(g.requires_approval).toBe(true);
    expect(g.memory_scope).toBe("isolated");

    // The legacy model is mirrored, split by catalogue kind.
    const emp = await svc()
      .from("ai_employees")
      .select("tools_allowed, permissions")
      .eq("slug", slug)
      .single();
    expect(emp.error, emp.error?.message).toBeNull();
    const e = emp.data as Record<string, unknown>;
    const perms = e.permissions as { scopes?: string[]; can_execute?: boolean; requires_approval?: boolean };
    expect(e.tools_allowed).toEqual([tTok]); // kind <> 'scope' → tools_allowed
    expect((perms.scopes ?? []).sort()).toEqual([sTok]); // kind = 'scope' → permissions.scopes
    // Posture survives the mirror (no execution unlock).
    expect(perms.can_execute).toBe(false);
    expect(perms.requires_approval).toBe(true);

    // PARITY: the union of the legacy halves equals the grant's token set…
    const union = Array.from(new Set([...(e.tools_allowed as string[]), ...(perms.scopes ?? [])])).sort();
    expect(union).toEqual(g.tokens);
    // …and the platform's own oracle agrees the employee is in parity.
    const parity = await parityOf(slug);
    expect(parity?.parity_ok, JSON.stringify(parity)).toBe(true);

    // The new tool token is now defined in the catalogue as a tool_permission.
    const cat = await svc().from("hq_capabilities").select("kind").eq("token", tTok).single();
    expect(cat.error, cat.error?.message).toBeNull();
    expect((cat.data as Record<string, unknown>).kind).toBe("tool_permission");

    await cleanup({ slugs: [slug], tokens: [tTok, sTok] });
  });

  it("re-authoring replaces the token set (update path) and preserves a non-default posture", async () => {
    const slug = mkSlug();
    const tokA = mkToken();
    const tokB = mkToken();
    // A distinctive posture + memory scope that LR1 must leave untouched.
    await createEmployee(slug, {
      permissions: { can_execute: false, requires_approval: false, scopes: [] },
      memory_scope: "department",
    });

    const first = await author({ p_slug: slug, p_tokens: [tokA], p_actor_email: "it@crewflow.uk" });
    expect(first.error, first.error?.message).toBeNull();
    expect((first.data as Record<string, unknown>).action).toBe("created");

    const second = await author({ p_slug: slug, p_tokens: [tokB], p_actor_email: "it@crewflow.uk" });
    expect(second.error, second.error?.message).toBeNull();
    expect((second.data as Record<string, unknown>).action).toBe("updated");

    const grant = await svc()
      .from("hq_capability_grants")
      .select("tokens, can_execute, requires_approval, memory_scope")
      .eq("scope_key", slug)
      .single();
    const g = grant.data as Record<string, unknown>;
    expect(g.tokens).toEqual([tokB]); // the set is REPLACED, not merged
    // Posture + memory scope preserved across the update (tokens-only authoring).
    expect(g.can_execute).toBe(false);
    expect(g.requires_approval).toBe(false);
    expect(g.memory_scope).toBe("department");

    const emp = await svc().from("ai_employees").select("tools_allowed, permissions, memory_scope").eq("slug", slug).single();
    const e = emp.data as Record<string, unknown>;
    const perms = e.permissions as { can_execute?: boolean; requires_approval?: boolean };
    expect(e.tools_allowed).toEqual([tokB]);
    expect(perms.can_execute).toBe(false);
    expect(perms.requires_approval).toBe(false); // the non-default survived the mirror
    expect(e.memory_scope).toBe("department");

    const parity = await parityOf(slug);
    expect(parity?.parity_ok, JSON.stringify(parity)).toBe(true);

    await cleanup({ slugs: [slug], tokens: [tokA, tokB] });
  });

  it("an unknown employee is rejected with a clean envelope and NO catalogue side effect", async () => {
    const ghost = mkSlug();
    const tok = mkToken();
    const res = await author({ p_slug: ghost, p_tokens: [tok], p_actor_email: "it@crewflow.uk" });
    expect(res.error, res.error?.message).toBeNull();
    const env = res.data as Record<string, unknown>;
    expect(env.ok).toBe(false);
    expect(env.reason).toBe("unknown_employee");

    // The early return happens BEFORE any catalogue write — the token must not exist.
    const cat = await svc().from("hq_capabilities").select("token").eq("token", tok);
    expect(cat.data ?? []).toHaveLength(0);
  });

  it("a malformed token is rejected with a clean envelope and NO write", async () => {
    const slug = mkSlug();
    await createEmployee(slug);
    const res = await author({ p_slug: slug, p_tokens: ["bad token"], p_actor_email: "it@crewflow.uk" });
    expect(res.error, res.error?.message).toBeNull();
    const env = res.data as Record<string, unknown>;
    expect(env.ok).toBe(false);
    expect(env.reason).toBe("invalid_token");

    // The format check precedes every write — no grant was created for the employee.
    const grant = await svc().from("hq_capability_grants").select("id").eq("scope_key", slug);
    expect(grant.data ?? []).toHaveLength(0);

    await cleanup({ slugs: [slug] });
  });

  it("anon cannot execute the authoring RPC — EXECUTE is service-role only", async () => {
    const res = await author({ p_slug: mkSlug(), p_tokens: [] }, "anon");
    expect(res.error, "anon must be denied EXECUTE on the authoring RPC").not.toBeNull();
  });
});
