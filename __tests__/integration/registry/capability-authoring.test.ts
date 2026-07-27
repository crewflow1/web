import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * The Capability Registry — registry-native capability authoring, at the registry-SOLE end
 * state (LR5.4B), real-Postgres proof.
 *
 * CEO Directive #015 / D-05. The authoring RPC was introduced by LR1 (Legacy Removal increment
 * 1, migration 20260808000000), REDEFINED by LR5.1 (increment 5.1, migration 20260810000000)
 * which retired the legacy mirror — the first step of the Removal Sequencing Rule (23rd §2
 * standard: "first remove writes") — and RE-POINTED by LR5.4B (increment 5.4B, migration
 * 20260812000000) OFF the now-dropped `ai_employees.permissions` column (the Legacy Independence
 * Rule, 28th; the Hidden Read Path Rule, 27th). ADR:
 * docs/bible/decisions/0010-capability-registry.md.
 *
 * The security tier pins each migration's CONTRACT against source text; this tier proves the
 * BEHAVIOUR the live RPC exhibits NOW that text can't ("mocks prove intent; real infrastructure
 * proves behaviour"): that the atomic authoring RPC defines tokens, writes the employee grant
 * authoritatively (tokens only), PRESERVES posture + memory scope on re-authoring, and — post
 * LR5.4B — seeds a FRESH grant's posture from the DENY FLOOR (it reads no dropped column; the
 * floor is identical to the default-locked legacy value it replaced, so behaviour is preserved).
 * The return envelope still reports the catalogue-faithful kind split (it backs the admin
 * activity log). The service-role lockdown still denies anon. All in a live database.
 *
 * THE LEGACY COLUMNS ARE GONE. LR5.4B dropped `ai_employees.tools_allowed` / `permissions` and
 * the parity oracle that compared them to the registry, so the former "the mirror stays inert" /
 * "the oracle reports the expected divergence" assertions are retired — there is nothing left to
 * mirror to or compare against. The grant IS the authority.
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

/** Define a capability token of a given kind; caller cleans it up. */
async function defineCapability(
  token: string,
  kind: "tool_permission" | "scope" = "tool_permission",
): Promise<void> {
  const res = await svc().from("hq_capabilities").insert({ token, kind });
  expect(res.error, res.error?.message).toBeNull();
}

/** Create an ai_employee fixture; returns its id. LR5.4B dropped tools_allowed / permissions. */
async function createEmployee(
  slug: string,
  opts: { memory_scope?: string } = {},
): Promise<string> {
  const res = await svc()
    .from("ai_employees")
    .insert({
      name: `IT ${slug}`,
      slug,
      role: "Integration fixture",
      department: "engineering",
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

describeIntegration("Capability Registry · registry-native authoring, post-LR5.4B (D-05)", () => {
  it("authors a fresh employee — defines tokens, writes the grant (tokens-only), seeds the deny-floor posture; reads no dropped column", async () => {
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

    // The grant holds the sorted-distinct authored set at the employee scope — the AUTHORITATIVE
    // write. Its posture is the DENY FLOOR (LR5.4B seeds a fresh grant from the floor, not the
    // removed legacy permissions) and its memory_scope is the employee's surviving column value.
    const grant = await svc()
      .from("hq_capability_grants")
      .select("tokens, can_execute, requires_approval, memory_scope")
      .eq("scope_key", slug)
      .single();
    expect(grant.error, grant.error?.message).toBeNull();
    const g = grant.data as Record<string, unknown>;
    expect(g.tokens).toEqual(expectedTokens);
    expect(g.can_execute).toBe(false); // deny floor (Directive 001 — born locked)
    expect(g.requires_approval).toBe(true);
    expect(g.memory_scope).toBe("isolated"); // seeded from the surviving ai_employees.memory_scope

    // The return envelope reports the catalogue-faithful kind split (it backs the admin activity
    // log), sourced from hq_capabilities — never a legacy column.
    expect(env.tools_allowed).toEqual([tTok]); // kind <> 'scope' → tools_allowed
    expect(env.scopes).toEqual([sTok]); // kind = 'scope' → scopes

    // The new tool token is now defined in the catalogue as a tool_permission.
    const cat = await svc().from("hq_capabilities").select("kind").eq("token", tTok).single();
    expect(cat.error, cat.error?.message).toBeNull();
    expect((cat.data as Record<string, unknown>).kind).toBe("tool_permission");

    await cleanup({ slugs: [slug], tokens: [tTok, sTok] });
  });

  it("re-authoring replaces the token set (update path) and preserves the grant's posture + memory scope (tokens-only authoring)", async () => {
    const slug = mkSlug();
    const tokA = mkToken();
    const tokB = mkToken();
    await createEmployee(slug, { memory_scope: "department" });

    // First author → a fresh grant, born at the deny floor with the employee's memory_scope.
    const first = await author({ p_slug: slug, p_tokens: [tokA], p_actor_email: "it@crewflow.uk" });
    expect(first.error, first.error?.message).toBeNull();
    expect((first.data as Record<string, unknown>).action).toBe("created");

    // Set a DISTINCTIVE, non-default posture on the grant directly — the value tokens-only
    // re-authoring must leave untouched. The registry is now the SOLE authority, so this is set
    // on the grant itself (there is no legacy column to seed it from).
    const posture = await svc()
      .from("hq_capability_grants")
      .update({ requires_approval: false })
      .eq("scope_level", "employee")
      .eq("scope_key", slug);
    expect(posture.error, posture.error?.message).toBeNull();

    // Re-author with a different token set → the UPDATE path (tokens replaced, posture preserved).
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
    expect(g.requires_approval).toBe(false); // the non-default value we set — untouched
    expect(g.memory_scope).toBe("department");

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
