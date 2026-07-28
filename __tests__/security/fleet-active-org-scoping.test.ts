import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Active-org scoping — the FLEET domain must pin every read and write to
 * ctx.org.id.
 *
 * THE INVARIANT: RLS's `current_org_ids()` returns EVERY org the viewer belongs
 * to, and `is_org_admin(org_id)` passes for every org they administer. Neither
 * constrains anything to the ACTIVE org (the `active_org_id` cookie). So a
 * fleet read or write with no org predicate lets a user working in org A see
 * and mutate org B's vehicles.
 *
 * This tier pins the invariant on SOURCE — the documented convention already
 * used by __tests__/security/active-org-scoping.test.ts (jobs) and
 * bank-match-invoice-org-scope.test.ts — because these are Server Actions and
 * RSC pages coupled to createClient + requireOrgContext + cookies(), which the
 * repo has no mock harness for. The RUNTIME proof against a real dual-org user
 * lives in __tests__/integration/rls/fleet-isolation.test.ts.
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
  return source.slice(next === -1 ? start : start, next === -1 ? undefined : next);
}

describe("server/services/fleet-snapshot — every read carries the org predicate", () => {
  const SRC = src("server/services/fleet-snapshot.ts");

  it("the shared paged reader pins org_id", () => {
    expect(SRC).toMatch(/\.eq\("org_id", orgId\)/);
  });

  it("pages with a UNIQUE tiebreaker so no vehicle is dropped at a page edge", () => {
    // fetchAllRows requires a TOTAL order; a non-unique sort key can drop or
    // repeat rows across a page boundary.
    expect(SRC).toMatch(/\.order\(idKey, \{ ascending: true \}\)/);
    expect(SRC).toMatch(/pagedRows\(db, "fleet_vehicles", VEHICLE_COLS, orgId, "asset_id"\)/);
  });

  it("loads the asset half org-pinned too — both halves of the join", () => {
    expect(SRC).toMatch(/pagedRows\(db, "assets", ASSET_COLS, orgId\)/);
  });

  it("pins the fuel read to the org before any optional asset narrowing", () => {
    expect(SRC).toMatch(
      /db\s*\.from\("asset_fuel_logs"\)\s*\.select\(FUEL_COLS\)\s*\.eq\("org_id", orgId\)/,
    );
  });

  it("pins the vehicle-detail reads to BOTH the org and the asset", () => {
    expect(SRC).toMatch(
      /db\.from\(table\)\.select\(cols\)\.eq\("org_id", orgId\)\.eq\("asset_id", assetId\)/,
    );
  });

  it("does not fall back to an unpinned select anywhere", () => {
    // A `.from(x).select(y)` immediately awaited with no .eq("org_id"…) would
    // be RLS-only and therefore multi-org.
    expect(SRC).not.toMatch(/\.from\("fleet_vehicles"\)\s*\.select\([^)]*\)\s*[;,)]/);
  });
});

describe("fleet by-id loads go through the scoped chokepoint", () => {
  const LOAD = src("app/(app)/fleet/_components/load.ts");

  it("loadVehicleForOrg takes an orgId and resolves within that org only", () => {
    expect(LOAD).toMatch(/export async function loadVehicleForOrg\(\s*orgId: string,/);
    expect(LOAD).toMatch(/loadFleetVehicles\(orgId\)/);
  });

  it("returns null rather than throwing, so a foreign id is a not-found", () => {
    expect(LOAD).toMatch(/Promise<FleetVehicle \| null>/);
  });

  it("the supplier options read is org-pinned", () => {
    expect(LOAD).toMatch(/\.eq\("org_id", orgId\)/);
  });

  const pages: Array<[string, string]> = [
    ["app/(app)/fleet/vehicles/[id]/page.tsx", "the vehicle detail page"],
    ["app/(app)/fleet/vehicles/[id]/edit/page.tsx", "the vehicle edit page"],
  ];

  for (const [path, label] of pages) {
    it(`${label} loads through loadVehicleForOrg with ctx.org.id`, () => {
      const SRC = src(path);
      expect(SRC, `${path} should import the chokepoint`).toMatch(
        /import \{[^}]*loadVehicleForOrg[^}]*\} from/,
      );
      expect(SRC, `${path} should pass the active org`).toMatch(
        /loadVehicleForOrg\(ctx\.org\.id, id\)/,
      );
    });

    it(`${label} treats a missing or foreign vehicle as notFound()`, () => {
      expect(src(path)).toMatch(/if \(!vehicle\) notFound\(\)/);
    });
  }

  it("the detail page also pins its composed spine reads to the active org", () => {
    expect(src("app/(app)/fleet/vehicles/[id]/page.tsx")).toMatch(
      /loadVehicleDetail\(ctx\.org\.id, id\)/,
    );
  });
});

describe("fleet list surfaces are org-pinned", () => {
  const surfaces: Array<[string, string]> = [
    ["app/(app)/fleet/page.tsx", "loadFleetOverview"],
    ["app/(app)/fleet/vehicles/page.tsx", "loadFleetVehicles"],
    ["app/(app)/fleet/compliance/page.tsx", "loadFleetVehicles"],
    ["app/(app)/fleet/fuel/page.tsx", "loadFleetOverview"],
  ];

  for (const [path, loader] of surfaces) {
    it(`${path} passes ctx.org.id into ${loader}`, () => {
      const SRC = src(path);
      expect(SRC).toMatch(/const \{ ctx \} = await requireOrgContext\(\)/);
      expect(SRC).toMatch(new RegExp(`${loader}\\(ctx\\.org\\.id`));
    });
  }
});

describe("fleet writes — every mutation is pinned to the active org", () => {
  const ACTIONS = src("app/(app)/fleet/actions.ts");
  const COMPLIANCE = src("app/(app)/fleet/compliance-actions.ts");
  const FUEL = src("app/(app)/fleet/fuel-actions.ts");

  it("createVehicle captures ctx and passes it as the RPC's org", () => {
    const F = fn(ACTIONS, "createVehicle");
    expect(F).toMatch(/const \{ ctx, user \} = await requireOrgContext\(\)/);
    expect(F).toMatch(/rpcArgs\(parsed\.data!, ctx\.org\.id, null, user\.id, ownership\)/);
  });

  it("updateVehicle passes the active org as the RPC's org pin", () => {
    const F = fn(ACTIONS, "updateVehicle");
    expect(F).toMatch(/const \{ ctx, user \} = await requireOrgContext\(\)/);
    expect(F).toMatch(/rpcArgs\(parsed\.data!, ctx\.org\.id, id, user\.id, ownership\)/);
  });

  it("rpcArgs maps orgId onto p_org_id — the predicate the RPC scopes by", () => {
    expect(ACTIONS).toMatch(/p_org_id: orgId/);
  });

  it("removeVehicleProfile scopes the DELETE by org_id and is count-gated", () => {
    const F = fn(ACTIONS, "removeVehicleProfile");
    expect(F).toMatch(/\.eq\("asset_id", id\)\s*\.eq\("org_id", ctx\.org\.id\)/);
    expect(F).toMatch(/if \(!count\)/);
  });

  it("saveComplianceSchedule stamps org_id from ctx", () => {
    const F = fn(COMPLIANCE, "saveComplianceSchedule");
    expect(F).toMatch(/org_id: ctx\.org\.id/);
  });

  it("deactivateComplianceSchedule scopes the UPDATE by org_id and is count-gated", () => {
    const F = fn(COMPLIANCE, "deactivateComplianceSchedule");
    expect(F).toMatch(/\.eq\("id", scheduleId\)\s*\.eq\("org_id", ctx\.org\.id\)/);
    expect(F).toMatch(/if \(!count\)/);
  });

  it("recordComplianceCompletion passes the active org into the RPC", () => {
    const F = fn(COMPLIANCE, "recordComplianceCompletion");
    expect(F).toMatch(/p_org_id: ctx\.org\.id/);
  });

  it("createFuelLog stamps org_id from ctx", () => {
    const F = fn(FUEL, "createFuelLog");
    expect(F).toMatch(/org_id: ctx\.org\.id/);
  });

  it("deleteFuelLog scopes the DELETE by org_id and is count-gated", () => {
    const F = fn(FUEL, "deleteFuelLog");
    expect(F).toMatch(/\.eq\("id", id\)\s*\.eq\("org_id", ctx\.org\.id\)/);
    expect(F).toMatch(/if \(!count\)/);
  });

  it("no fleet action writes through the RLS-bypassing admin client", () => {
    // Service-role writes would bypass RLS entirely; fleet writes must all go
    // through the tenant (user-JWT) client so the caller's policies apply.
    for (const [name, SRC] of [
      ["actions", ACTIONS],
      ["compliance-actions", COMPLIANCE],
      ["fuel-actions", FUEL],
    ] as const) {
      expect(SRC, `${name} must not import the admin client`).not.toMatch(
        /createAdminClient|supabase\/admin/,
      );
    }
  });

  it("every fleet action requires an org context before touching the database", () => {
    for (const SRC of [ACTIONS, COMPLIANCE, FUEL]) {
      const exported = SRC.match(/export async function \w+/g) ?? [];
      const gates = SRC.match(/await requireOrgContext\(\)/g) ?? [];
      expect(gates.length).toBeGreaterThanOrEqual(exported.length);
    }
  });
});

describe("fleet migrations — the cross-tenant controls are declarative", () => {
  const M56 = src("supabase/migrations/20261056000000_fleet_vehicles.sql");
  const M58 = src("supabase/migrations/20261058000000_asset_fuel_logs.sql");

  it("assets gains the (id, org_id) candidate key the composite FKs need", () => {
    expect(M56).toMatch(/alter table public\.assets add constraint assets_id_org_key unique \(id, org_id\)/);
  });

  it("fleet_vehicles references assets by (asset_id, org_id), not by id alone", () => {
    expect(M56).toMatch(
      /foreign key \(asset_id, org_id\) references public\.assets \(id, org_id\)/,
    );
  });

  it("asset_fuel_logs uses the same composite FK", () => {
    expect(M58).toMatch(
      /foreign key \(asset_id, org_id\) references public\.assets \(id, org_id\)/,
    );
  });

  it("both new tables enable RLS", () => {
    expect(M56).toMatch(/alter table public\.fleet_vehicles enable row level security/);
    expect(M58).toMatch(/alter table public\.asset_fuel_logs enable row level security/);
  });

  it("both new tables restrict DELETE to org admins", () => {
    expect(M56).toMatch(/create policy fleet_vehicles_delete[\s\S]*?public\.is_org_admin\(org_id\)/);
    expect(M58).toMatch(/create policy asset_fuel_logs_delete[\s\S]*?public\.is_org_admin\(org_id\)/);
  });

  it("the save RPC pins both of its UPDATE statements to p_org_id", () => {
    const body = M56.slice(M56.indexOf("create or replace function public.save_fleet_vehicle"));
    expect(body).toMatch(/update public\.assets set[\s\S]*?where id = p_asset_id and org_id = p_org_id/);
    expect(body).toMatch(
      /update public\.fleet_vehicles set[\s\S]*?where asset_id = p_asset_id and org_id = p_org_id/,
    );
  });

  it("neither RPC is SECURITY DEFINER — no privilege is granted over the caller's own", () => {
    expect(M56).not.toMatch(/security definer/i);
    expect(src("supabase/migrations/20261057000000_fleet_compliance.sql")).not.toMatch(
      /security definer/i,
    );
  });

  it("no fleet table uses a generated column", () => {
    for (const M of [M56, M58]) {
      expect(M).not.toMatch(/generated\s+always\s+as/i);
    }
  });
});
