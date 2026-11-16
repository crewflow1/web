import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration } from "../_harness";
import {
  createWorld,
  destroyWorld,
  loadSurface,
  rawFetch,
  seedOrgRows,
  svc,
  type SeedResult,
  type Surface,
  type World,
} from "./_fixture";
import { writeReport } from "./_report";

/**
 * ATTACK 1 — the anonymous holder of the PUBLIC anon key, no session.
 *
 * The anon key ships in every browser bundle; assume the attacker has it. This suite
 * walks the WHOLE Data API surface as that attacker, driven by the live catalogue:
 *
 *   tables/views   GET every relation in every exposed schema  → must return no row
 *                  POST `{}` to every relation                 → must not create a row
 *   boundary rows  PATCH / DELETE the organisation, user profile and pay rows of a real
 *                  org by primary key                          → ground truth unchanged
 *   GraphQL        /graphql/v1 collections                     → no row
 *   GoTrue         admin endpoints with the anon key           → refused
 *
 * (Row-level UPDATE/DELETE/forge against every org-scoped table, every function and
 * every bucket are attacked as `anon` in cross-tenant-tables / rpc-surface / storage —
 * anon is one of the attackers there.)
 *
 * The world is seeded first (one row in ~190 org-scoped tables for a real org) so that
 * "returned no row" is a statement about RLS, not about empty tables.
 *
 * What anon CAN reach is written to the evidence report and documented, item by item,
 * in docs/programme/security-tenant/ANON-SURFACE.md.
 */

/** Relations from which anon may legitimately read rows. Empty: nothing is public data. */
const ANON_READABLE: ReadonlyMap<string, string> = new Map<string, string>([]);

describeIntegration("ADVERSARIAL · the anonymous public-key holder — every table, view and GraphQL collection", () => {
  let w: World | null = null;
  let surface: Surface;
  let seedB: SeedResult;
  const report: { relation: string; kind: string; grants: string[]; get: number; rows: number; post: number | null }[] = [];

  beforeAll(async () => {
    surface = await loadSurface();
    w = await createWorld("sectenant-anon");
    seedB = await seedOrgRows(surface, w.B.id, w.B.owner.id, `${w.tag}-b`);
  }, 300_000);

  afterAll(async () => {
    writeReport("anon-surface.json", { report });
    await destroyWorld(w);
  }, 300_000);

  it("anon reads NO row from any relation and can create NO row in any relation", async () => {
    expect(seedB.rows.size).toBeGreaterThan(100);
    const leaks: string[] = [];
    const created: string[] = [];
    expect(surface.relations.length).toBeGreaterThan(300);

    for (const rel of surface.relations) {
      const profile: Record<string, string> =
        rel.schema === "public" ? {} : { "Accept-Profile": rel.schema, "Content-Profile": rel.schema };
      const get = await rawFetch(`/rest/v1/${rel.name}?limit=3`, { headers: profile });
      const rows = get.status >= 200 && get.status < 300 && Array.isArray(get.json) ? get.json.length : 0;
      if (rows > 0 && !ANON_READABLE.has(rel.name)) leaks.push(`${rel.schema}.${rel.name}: ${rows} row(s) → ${get.text.slice(0, 120)}`);

      let post: number | null = null;
      if (rel.kind === "r" || rel.kind === "p") {
        const ins = await rawFetch(`/rest/v1/${rel.name}`, {
          method: "POST",
          body: {},
          headers: { ...profile, Prefer: "return=representation" },
        });
        post = ins.status;
        if (ins.status >= 200 && ins.status < 300) {
          created.push(`${rel.schema}.${rel.name}: HTTP ${ins.status} ${ins.text.slice(0, 120)}`);
          // Clean up the row the hole let us create (best effort, by returned id).
          const id = Array.isArray(ins.json) ? ins.json[0]?.id : null;
          if (id) await svc().from(rel.name).delete().eq("id", id);
        }
      }
      report.push({ relation: `${rel.schema}.${rel.name}`, kind: rel.kind, grants: rel.anon, get: get.status, rows, post });
    }

    expect(leaks, `ANON READ ROWS:\n  ${leaks.join("\n  ")}`).toEqual([]);
    expect(created, `ANON CREATED ROWS:\n  ${created.join("\n  ")}`).toEqual([]);
  }, 600_000);

  it("anon cannot alter or delete the tenant-boundary rows (organisation, membership, user profile, pay) by primary key", async () => {
    const world = w!;
    await svc().from("staff_compensation").upsert({ user_id: world.B.staff.id, hourly_pay: 17.25 }, { onConflict: "user_id" });
    const snapshot = async () => ({
      org: (await svc().from("organizations").select("*").eq("id", world.B.id).maybeSingle()).data,
      user: (await svc().from("users").select("*").eq("id", world.B.owner.id).maybeSingle()).data,
      members: (await svc().from("memberships").select("id, role, user_id").eq("org_id", world.B.id).order("id")).data,
      pay: (await svc().from("staff_compensation").select("user_id, hourly_pay").eq("user_id", world.B.staff.id).maybeSingle()).data,
    });
    const before = await snapshot();
    expect(before.org).not.toBeNull();

    const attacks: [string, string, string, unknown][] = [
      ["PATCH", "organizations", `id=eq.${world.B.id}`, { name: "pwned", status: "cancelled", plan: "enterprise" }],
      ["DELETE", "organizations", `id=eq.${world.B.id}`, undefined],
      ["PATCH", "users", `id=eq.${world.B.owner.id}`, { full_name: "pwned", email: "pwned@example.test" }],
      ["DELETE", "users", `id=eq.${world.B.owner.id}`, undefined],
      ["PATCH", "memberships", `org_id=eq.${world.B.id}`, { role: "staff" }],
      ["DELETE", "memberships", `org_id=eq.${world.B.id}`, undefined],
      ["POST", "memberships", "", { org_id: world.B.id, user_id: world.A.owner.id, role: "owner" }],
      ["PATCH", "staff_compensation", `user_id=eq.${world.B.staff.id}`, { hourly_pay: 0 }],
      ["DELETE", "staff_compensation", `user_id=eq.${world.B.staff.id}`, undefined],
    ];
    for (const [method, table, query, body] of attacks) {
      await rawFetch(`/rest/v1/${table}${query ? `?${query}` : ""}`, { method, body, headers: { Prefer: "return=representation" } });
    }
    expect(await snapshot()).toEqual(before);
  });

  it("anon gets no row through GraphQL either (pg_graphql honours the same RLS)", async () => {
    const leaks: string[] = [];
    const outcomes: Record<string, number> = {};
    for (const t of ["organizations", "users", "memberships", "customers", "jobs", "invoices", "quotes", "api_keys", "staff_compensation"]) {
      const q = `{ ${t}Collection(first: 3) { edges { node { __typename } } } }`;
      const r = await rawFetch("/graphql/v1", { method: "POST", body: { query: q } });
      outcomes[t] = r.status;
      const edges = r.json?.data?.[`${t}Collection`]?.edges;
      if (Array.isArray(edges) && edges.length > 0) leaks.push(`${t}Collection returned ${edges.length} node(s)`);
    }
    writeReport("anon-graphql.json", { outcomes });
    expect(leaks).toEqual([]);
  });

  it("the anon key is refused by GoTrue admin endpoints and by service-only catalogue RPCs", async () => {
    const world = w!;
    const refused = async (path: string, init: Parameters<typeof rawFetch>[1] = {}) => {
      const r = await rawFetch(path, init);
      expect(r.status, `${path} → ${r.status} ${r.text.slice(0, 100)}`).toBeGreaterThanOrEqual(400);
      return r;
    };
    await refused("/auth/v1/admin/users");
    await refused(`/auth/v1/admin/users/${world.B.owner.id}`);
    await refused(`/auth/v1/admin/users/${world.B.owner.id}`, { method: "PUT", body: { password: "adv-new-password-1!" } });
    await refused("/auth/v1/admin/generate_link", { method: "POST", body: { type: "magiclink", email: world.B.owner.email } });
    await refused("/auth/v1/user"); // no session
    // The catalogue self-audit functions are a map of the attack surface: service_role only.
    for (const fn of [
      "_introspect_adversarial_surface",
      "_introspect_secdef_org_rpcs",
      "_introspect_bare_cross_tenant_fks",
      "_introspect_org_scoped_tables",
    ]) {
      await refused(`/rest/v1/rpc/${fn}`, { method: "POST", body: {} });
    }
    // The victim can still sign in afterwards (their password was not changed).
    const still = await rawFetch("/auth/v1/token?grant_type=password", {
      method: "POST",
      body: { email: world.B.owner.email, password: world.B.owner.password },
    });
    expect(still.status).toBe(200);
  });

  it("no stale ANON_READABLE entries", () => {
    const names = new Set(surface.relations.map((r) => r.name));
    for (const n of ANON_READABLE.keys()) expect(names.has(n), `${n} no longer exists`).toBe(true);
  });
});
