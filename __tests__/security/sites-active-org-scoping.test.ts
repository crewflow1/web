import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Active-org scoping — the SITES domain, and the two pickers it feeds.
 *
 * THE INVARIANT: RLS's `current_org_ids()` returns EVERY org the viewer belongs
 * to, and `is_org_admin(org_id)` passes for every org they administer. Neither
 * constrains anything to the ACTIVE org (the `active_org_id` cookie). So a
 * sites read or write with no org predicate lets a user working in company A
 * see and rename company B's depots — and, worse, lets the fleet and custody
 * pickers OFFER a site that the site-org guard then refuses at write time.
 *
 * This tier pins the invariant on SOURCE — the documented convention already
 * used by active-org-scoping.test.ts (jobs), active-org-supplier-scoping.test.ts
 * and fleet-active-org-scoping.test.ts — because these are Server Actions and
 * RSC pages coupled to createClient + requireOrgContext + cookies(), which the
 * repo has no mock harness for. The RUNTIME proof against a real dual-org user
 * lives in __tests__/integration/rls/sites-isolation.test.ts.
 *
 * Every assertion here fails if the corresponding pin is deleted.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/** Extract one exported function body so a sibling can't satisfy an assertion. */
function fn(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = source.indexOf("\nexport async function", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("server/services/sites — every read carries the org predicate", () => {
  const SRC = src("server/services/sites.ts");

  it("loadSiteForOrg pins BOTH the id and the org", () => {
    const F = fn(SRC, "loadSiteForOrg");
    expect(F).toMatch(/\.eq\("id", siteId\)\s*\.eq\("org_id", orgId\)/);
  });

  it("loadSiteForOrg returns null rather than throwing, so a foreign id is a not-found", () => {
    expect(SRC).toMatch(/loadSiteForOrg[\s\S]*?Promise<T \| null>/);
  });

  it("listSitesForOrg pins the org", () => {
    expect(fn(SRC, "listSitesForOrg")).toMatch(/\.eq\("org_id", orgId\)/);
  });

  it("loadSiteUsageForOrg pins BOTH reference reads to the org", () => {
    const F = fn(SRC, "loadSiteUsageForOrg");
    // Counts drive whether the delete button is shown at all; blending orgs
    // here would make a site look "in use" because of an invisible estate.
    expect(F).toMatch(/\.from\("fleet_vehicles"\)[\s\S]*?\.eq\("org_id", orgId\)/);
    expect(F).toMatch(/\.from\("asset_assignments"\)[\s\S]*?\.eq\("org_id", orgId\)/);
  });

  it("the picker helper goes through the pinned list, never a bare select", () => {
    expect(fn(SRC, "listSiteOptionsForOrg")).toMatch(/listSitesForOrg(<[^>]+>)?\(db, orgId/);
  });

  it("does not fall back to an unpinned select anywhere", () => {
    expect(SRC).not.toMatch(/\.from\("sites"\)\s*\.select\([^)]*\)\s*[;,)]/);
  });
});

describe("sites writes — every mutation is pinned to the active org", () => {
  const ACTIONS = src("app/(app)/sites/actions.ts");

  it("createSite stamps org_id from ctx rather than trusting the form", () => {
    const F = fn(ACTIONS, "createSite");
    expect(F).toMatch(/const \{ ctx, user \} = await requireOrgContext\(\)/);
    expect(F).toMatch(/org_id: ctx\.org\.id/);
  });

  it("updateSite scopes the UPDATE by org_id and is count-gated", () => {
    const F = fn(ACTIONS, "updateSite");
    expect(F).toMatch(/\.eq\("id", id\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
    expect(F).toMatch(/if \(count === 0\)/);
  });

  it("setSiteActive scopes the UPDATE by org_id and is count-gated", () => {
    const F = fn(ACTIONS, "setSiteActive");
    expect(F).toMatch(/\.eq\("id", id\)\s*\.eq\("org_id", ctx\.org\.id\)/);
    expect(F).toMatch(/if \(!count\)/);
  });

  it("deleteSite scopes the DELETE by org_id and is count-gated", () => {
    const F = fn(ACTIONS, "deleteSite");
    expect(F).toMatch(/\.eq\("id", id\)[\s\S]*?\.eq\("org_id", ctx\.org\.id\)/);
    expect(F).toMatch(/if \(!count\)/);
  });

  it("no site action writes through the RLS-bypassing admin client", () => {
    // A service-role write would bypass `sites_insert/update/delete`, which are
    // is_org_admin(org_id) — i.e. it would bypass the whole admin gate.
    expect(ACTIONS).not.toMatch(/createAdminClient|supabase\/admin/);
  });

  it("every site action requires an org context before touching the database", () => {
    const exported = ACTIONS.match(/export async function \w+/g) ?? [];
    const gates = ACTIONS.match(/await requireOrgContext\(\)/g) ?? [];
    expect(exported.length).toBeGreaterThan(0);
    expect(gates.length).toBeGreaterThanOrEqual(exported.length);
  });
});

describe("sites surfaces are org-pinned", () => {
  const surfaces: Array<[string, RegExp]> = [
    ["app/(app)/sites/page.tsx", /listSitesForOrg<SiteRow>\(db, ctx\.org\.id\)/],
    ["app/(app)/sites/[id]/page.tsx", /loadSiteForOrg<SiteRow>\(db, ctx\.org\.id, id\)/],
  ];

  for (const [path, re] of surfaces) {
    it(`${path} passes ctx.org.id into the scoped loader`, () => {
      const SRC = src(path);
      expect(SRC).toMatch(/const \{ ctx \} = await requireOrgContext\(\)/);
      expect(SRC).toMatch(re);
    });
  }

  it("the detail page treats a missing or foreign site as notFound()", () => {
    expect(src("app/(app)/sites/[id]/page.tsx")).toMatch(/if \(!site\) notFound\(\)/);
  });
});

describe("the site pickers embedded in other domains are org-pinned", () => {
  it("the fleet picker resolves through the org-scoped service", () => {
    const LOAD = src("app/(app)/fleet/_components/load.ts");
    expect(LOAD).toMatch(/export async function loadSiteOptions\(\s*orgId: string,/);
    expect(LOAD).toMatch(/listSiteOptionsForOrg\([\s\S]*?orgId/);
  });

  const fleetPages: Array<[string, string]> = [
    ["app/(app)/fleet/vehicles/new/page.tsx", "the add-vehicle form"],
    ["app/(app)/fleet/vehicles/[id]/edit/page.tsx", "the edit-vehicle form"],
    ["app/(app)/fleet/vehicles/[id]/page.tsx", "the vehicle detail page"],
  ];

  for (const [path, label] of fleetPages) {
    it(`${label} passes the active org into loadSiteOptions`, () => {
      expect(src(path)).toMatch(/loadSiteOptions\(ctx\.org\.id/);
    });
  }

  it("the custody picker on the asset page is org-pinned", () => {
    const SRC = src("app/(app)/assets/[id]/page.tsx");
    expect(SRC).toMatch(/listSiteOptionsForOrg\([\s\S]{0,160}?ctx\.org\.id/);
  });

  it("the fleet save RPC carries the chosen site as an argument, not a raw write", () => {
    // The RPC is what pins the active org on both of its UPDATEs, so the site
    // must ride it rather than being patched onto fleet_vehicles separately.
    expect(src("app/(app)/fleet/actions.ts")).toMatch(/p_home_site_id: d\.home_site_id \?\? null/);
  });

  it("the custody actions pass the site through both the insert and the transfer RPC", () => {
    const SRC = src("app/(app)/assets/assignment-actions.ts");
    expect(SRC).toMatch(/site_id: d\.site_id \?\? null/);
    expect(SRC).toMatch(/p_site_id: d\.site_id \?\? null/);
  });
});

describe("20261061000000_sites — the controls are in the database", () => {
  const M = src("supabase/migrations/20261061000000_sites.sql");
  // Assert on executable SQL only, so the header's prose can never satisfy an
  // assertion about what the migration actually does.
  const sql = M.replace(/--.*$/gm, "");

  it("enables RLS on sites", () => {
    expect(sql).toMatch(/alter table public\.sites enable row level security/);
  });

  it("members read, admins write — the reference-data posture", () => {
    expect(sql).toMatch(
      /create policy sites_select on public\.sites\s*for select using \(org_id in \(select public\.current_org_ids\(\)\)\)/,
    );
    for (const verb of ["insert", "update", "delete"]) {
      expect(sql, `${verb} must be admin-gated`).toMatch(
        new RegExp(`create policy sites_${verb} on public\\.sites[\\s\\S]*?public\\.is_org_admin\\(org_id\\)`),
      );
    }
  });

  it("names are unique per org, case-insensitively (the suppliers precedent)", () => {
    expect(sql).toMatch(
      /create unique index if not exists sites_org_name_unique\s*on public\.sites \(org_id, lower\(name\)\)/,
    );
  });

  it("deliberately has no 'job_site' kind — job addresses stay on the job", () => {
    const kindCheck = sql.match(/check \(kind in \([^)]*\)\)/)?.[0] ?? "";
    expect(kindCheck, "kind CHECK not found").not.toBe("");
    expect(kindCheck).not.toMatch(/job_site/);
    for (const kind of ["depot", "yard", "warehouse", "office", "storage_container", "lock_up"]) {
      expect(kindCheck).toContain(kind);
    }
  });

  it("does not touch the job address columns at all", () => {
    expect(sql).not.toMatch(/site_address_line1|site_city|site_postcode/);
    expect(sql).not.toMatch(/alter table public\.jobs/);
  });

  it("both typed links are ON DELETE SET NULL, never CASCADE", () => {
    // A composite FK would force CASCADE, which would delete the VAN when a
    // depot was removed. Losing a depot must lose the link only.
    expect(sql).toMatch(
      /alter table public\.fleet_vehicles\s*add column if not exists home_site_id uuid references public\.sites\(id\) on delete set null/,
    );
    expect(sql).toMatch(
      /alter table public\.asset_assignments\s*add column if not exists site_id uuid references public\.sites\(id\) on delete set null/,
    );
    expect(sql).not.toMatch(/references public\.sites\(id\) on delete cascade/);
  });

  it("a cross-org site reference is refused by a trigger on BOTH tables", () => {
    expect(sql).toMatch(/create or replace function public\.tg_site_reference_org_integrity\(\)/);
    expect(sql).toMatch(/security definer set search_path = public/);
    expect(sql).toMatch(
      /create trigger fleet_vehicles_site_org\s*before insert or update on public\.fleet_vehicles[\s\S]*?tg_site_reference_org_integrity\('home_site_id'\)/,
    );
    expect(sql).toMatch(
      /create trigger asset_assignments_site_org\s*before insert or update on public\.asset_assignments[\s\S]*?tg_site_reference_org_integrity\('site_id'\)/,
    );
  });

  it("a referenced site cannot be deleted — deactivate is the route out", () => {
    expect(sql).toMatch(/create or replace function public\.tg_sites_delete_guard\(\)/);
    expect(sql).toMatch(/create trigger sites_delete_guard before delete on public\.sites/);
    expect(sql).toMatch(/deactivate it instead/);
  });

  it("the delete guard yields to an org teardown (the 20261052 cascade lesson)", () => {
    // Without this escape, `delete from organizations` would abort whenever a
    // vehicle still referenced a site — exactly the P1 20261052000000 fixed.
    const guard = sql.slice(sql.indexOf("function public.tg_sites_delete_guard"));
    expect(guard).toMatch(
      /if not exists \(select 1 from public\.organizations where id = old\.org_id\) then\s*return old;/,
    );
  });

  it("both RPCs are dropped by exact signature before being recreated", () => {
    // `create or replace` with an extra parameter leaves a second OVERLOAD
    // behind, which PostgREST then cannot resolve unambiguously.
    expect(sql).toMatch(/drop function if exists public\.save_fleet_vehicle\(/);
    expect(sql).toMatch(/drop function if exists public\.transfer_asset_assignment\(/);
  });

  it("the new RPC parameter is APPENDED with a default so old callers still resolve", () => {
    expect(sql).toMatch(/p_home_site_id\s+uuid default null\s*\)\s*returns uuid/);
    expect(sql).toMatch(/p_site_id\s+uuid default null\s*\)\s*returns uuid/);
  });

  it("neither RPC becomes SECURITY DEFINER — no privilege over the caller's own", () => {
    const save = sql.slice(sql.indexOf("create or replace function public.save_fleet_vehicle"));
    expect(save).not.toMatch(/security definer/i);
  });

  it("save_fleet_vehicle keeps the active-org pin on BOTH of its updates", () => {
    const body = sql.slice(sql.indexOf("create or replace function public.save_fleet_vehicle"));
    expect(body).toMatch(/update public\.assets set[\s\S]*?where id = p_asset_id and org_id = p_org_id/);
    expect(body).toMatch(
      /update public\.fleet_vehicles set[\s\S]*?where asset_id = p_asset_id and org_id = p_org_id/,
    );
  });

  it("is additive — it drops no table, column or policy and rewrites no data", () => {
    expect(sql).not.toMatch(/\bdrop\s+table\b/i);
    expect(sql).not.toMatch(/\bdrop\s+column\b/i);
    expect(sql).not.toMatch(/\bdrop\s+policy\b/i);
    expect(sql).not.toMatch(/\btruncate\b/i);
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
  });

  it("BACKFILLS NOTHING — no top-level DML at all", () => {
    // The RPC bodies legitimately contain UPDATEs (that is what saving a
    // vehicle does), so they are stripped before this check: what must not
    // exist is a MIGRATION-LEVEL statement rewriting existing rows, e.g. an
    // `update fleet_vehicles set home_site_id = (match on home_depot)`.
    // Matching free text to a site is a per-org judgement, not a schema act.
    const topLevel = sql.replace(/as \$\$[\s\S]*?end \$\$;/g, "");
    expect(topLevel).not.toMatch(/\bupdate\s+public\./i);
    expect(topLevel).not.toMatch(/\binsert\s+into\s+public\./i);
  });

  it("uses no generated column", () => {
    expect(sql).not.toMatch(/generated\s+always\s+as/i);
  });
});
