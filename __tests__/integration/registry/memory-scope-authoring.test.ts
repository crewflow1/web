import { expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";

/**
 * The Capability Registry — registry-native memory-scope authoring, at the registry-SOLE end
 * state (LR5.4B), real-Postgres proof.
 *
 * CEO Directive #015 / D-05. The memory-scope authoring RPC was introduced by LR2 (Legacy
 * Removal increment 2) and RE-POINTED by LR5.4B (increment 5.4B, migration 20260812000000)
 * OFF the now-dropped `ai_employees.permissions` / `tools_allowed` columns (the Legacy
 * Independence Rule, 28th; the Hidden Read Path Rule, 27th). ADR:
 * docs/bible/decisions/0010-capability-registry.md.
 *
 * The security tier pins each migration's CONTRACT against source text; this tier proves the
 * BEHAVIOUR the live RPC exhibits NOW that text can't ("mocks prove intent; real infrastructure
 * proves behaviour"): that the atomic memory-scope authoring RPC upserts the grant's memory_scope
 * authoritatively (memory_scope only), PRESERVES tokens + posture on re-authoring, and — post
 * LR5.4B — seeds a FRESH grant from the DENY FLOOR (no tokens, locked posture; it reads no
 * dropped column). The new memory_scope is mirrored to the SURVIVING `ai_employees.memory_scope`
 * in the same transaction (the Mirror Integrity Rule) — memory_scope is shared platform data,
 * OUT OF SCOPE for the drop, so that dual write is preserved. The service-role lockdown still
 * denies anon. All in a live database.
 *
 * THE PARITY ORACLE IS GONE. LR5.4B dropped `hq_capability_registry_parity()` (it compared the
 * grant's memory_scope to the legacy authority columns, which no longer exist), so the former
 * "holds parity" / "the oracle agrees" assertions are retired — there is nothing left to compare
 * against. The grant IS the authority; the surviving memory_scope mirror is shared data, not a
 * second authority.
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

/** Define a capability token; caller cleans it up. */
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

describeIntegration("Capability Registry · registry-native memory scope, post-LR5.4B (D-05)", () => {
  it("authors a fresh employee — born at the deny floor (EMPTY tokens, locked posture), moves memory_scope, mirrors to the surviving column", async () => {
    const slug = mkSlug();
    await createEmployee(slug, { memory_scope: "isolated" });

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

    // The grant takes the authored memory_scope and is born at the DENY FLOOR: LR5.4B seeds a
    // fresh grant with NO tokens and a locked posture (it reads no dropped column), not from the
    // removed legacy authority. The memory_scope is the authored value.
    const grant = await svc()
      .from("hq_capability_grants")
      .select("tokens, can_execute, requires_approval, memory_scope")
      .eq("scope_key", slug)
      .single();
    expect(grant.error, grant.error?.message).toBeNull();
    const g = grant.data as Record<string, unknown>;
    expect(g.memory_scope).toBe("department");
    expect(g.tokens).toEqual([]); // deny floor — a fresh memory-scope grant holds no tokens
    expect(g.can_execute).toBe(false); // deny floor (Directive 001 — born locked)
    expect(g.requires_approval).toBe(true);

    // The new memory_scope is mirrored to the SURVIVING ai_employees.memory_scope (shared platform
    // data, out of scope for the LR5.4B drop) in the same transaction — the deterministic mirror.
    const emp = await svc().from("ai_employees").select("memory_scope").eq("slug", slug).single();
    expect(emp.error, emp.error?.message).toBeNull();
    expect((emp.data as Record<string, unknown>).memory_scope).toBe("department");

    await cleanup({ slugs: [slug] });
  });

  it("re-authoring moves the scope (update path), preserves tokens + a non-default posture, idempotent", async () => {
    const slug = mkSlug();
    const tok = mkToken();
    await createEmployee(slug, { memory_scope: "isolated" });
    await defineCapability(tok);

    const first = await author({ p_slug: slug, p_memory_scope: "department", p_actor_email: "it@crewflow.uk" });
    expect(first.error, first.error?.message).toBeNull();
    expect((first.data as Record<string, unknown>).action).toBe("created");

    // Set a DISTINCTIVE, non-default posture AND a non-empty token set on the grant directly —
    // the values memory-scope-only authoring must leave untouched. The registry is the SOLE
    // authority, so these are set on the grant itself (there is no legacy column to seed them).
    const seed = await svc()
      .from("hq_capability_grants")
      .update({ tokens: [tok], requires_approval: false })
      .eq("scope_level", "employee")
      .eq("scope_key", slug);
    expect(seed.error, seed.error?.message).toBeNull();

    // Re-author with a different memory_scope → the UPDATE path (scope moves, tokens + posture
    // preserved).
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
    expect(g.tokens).toEqual([tok]); // tokens preserved across the memory-scope write
    expect(g.can_execute).toBe(false);
    expect(g.requires_approval).toBe(false); // the non-default posture we set — untouched

    // The surviving mirror moved with it.
    const emp = await svc().from("ai_employees").select("memory_scope").eq("slug", slug).single();
    expect((emp.data as Record<string, unknown>).memory_scope).toBe("global");

    // Reproducible: re-authoring the SAME value is an idempotent update that still preserves tokens.
    const again = await author({ p_slug: slug, p_memory_scope: "global", p_actor_email: "it@crewflow.uk" });
    expect((again.data as Record<string, unknown>).action).toBe("updated");
    const after = await svc()
      .from("hq_capability_grants")
      .select("tokens, memory_scope")
      .eq("scope_key", slug)
      .single();
    const a = after.data as Record<string, unknown>;
    expect(a.memory_scope).toBe("global");
    expect(a.tokens).toEqual([tok]);

    await cleanup({ slugs: [slug], tokens: [tok] });
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

    // The vocabulary check precedes every write — no grant created, the surviving column untouched.
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
