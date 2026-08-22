import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { navForRole } from "@/app/(app)/_nav/nav-model";

/**
 * Active-org scoping — the OPERATIONS command centre must pin every read to
 * ctx.org.id, and must never write.
 *
 * THE INVARIANT: RLS's `current_org_ids()` returns EVERY org the viewer belongs
 * to. Neither it nor `is_org_admin(org_id)` constrains anything to the ACTIVE
 * org (the `active_org_id` cookie). So an unpinned read here would put org B's
 * broken-down excavator, overdue inspection and late-back generator on org A's
 * command centre — the exact class this page aggregates the most of, because it
 * touches six tenant tables at once.
 *
 * This tier pins the invariant on SOURCE — the documented convention already
 * used by fleet-active-org-scoping.test.ts and active-org-scoping.test.ts —
 * because these are RSC pages coupled to createClient + requireOrgContext +
 * cookies(), which the repo has no mock harness for. The RUNTIME proof against
 * a real dual-org user lives in
 * __tests__/integration/rls/operations-isolation.test.ts.
 *
 * Every assertion here fails if the corresponding pin is deleted.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

/**
 * Comments explain the rules these modules DELEGATE to, so they legitimately
 * name them. The "no rule re-implemented here" assertions therefore run against
 * code only — otherwise a docblock quoting `daysAway <= 1` would fail a check
 * whose whole point is that the code does not perform that comparison.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

const SERVICE = src("server/services/operations-snapshot.ts");
const COMPOSE = src("lib/operations/compose.ts");
const PAGE = src("app/(app)/operations/page.tsx");

describe("server/services/operations-snapshot — every read carries the org predicate", () => {
  it("routes EVERY read through one paged reader that pins org_id", () => {
    // The single chokepoint. Delete this `.eq` and all six estate reads go
    // multi-org at once — which is why it is asserted on the exact chain.
    expect(SERVICE).toMatch(
      /build\(db\.from\(table\)\.select\(cols\)\.eq\("org_id", orgId\)\)/,
    );
  });

  it("pages with the UNIQUE primary key so no row shifts across a page edge", () => {
    // fetchAllRows requires a TOTAL order; a non-unique sort key (a date, an FK,
    // a status) can drop or repeat rows at a 500-row boundary.
    expect(SERVICE).toMatch(/\.order\("id", \{ ascending: true \}\)\s*\.range\(from, to\)/);
  });

  it("has no read that bypasses the pinned reader", () => {
    // Every `.from(...)` in the service must be the one inside pagedRows.
    const froms = SERVICE.match(/db\.from\(/g) ?? [];
    expect(froms).toHaveLength(1);
    // …and no direct table read that skips it.
    expect(SERVICE).not.toMatch(/supabase\s*\n?\s*\.from\(/);
  });

  it("passes the caller's orgId into every composed loader, never a default", () => {
    expect(SERVICE).toMatch(/loadFleetOverview\(orgId, todayIso\)/);
    expect(SERVICE).toMatch(/buildScheduleIntegrity\(orgId, \{ now/);
    expect(SERVICE).toMatch(/gatherOperationsFacts\(\s*supabase as unknown as OperationsClient,\s*orgId,/);
  });

  it("narrows the safety follow-up reads to ids it already read UNDER the org pin", () => {
    // The `.in("asset_id", failingAssetIds)` list is derived from an org-pinned
    // read, and the follow-up itself is org-pinned too — so neither half can
    // reach another tenant's inspection history.
    expect(SERVICE).toMatch(/failingAssetIds = \[\.\.\.new Set\(safetyFails\.map/);
    expect(SERVICE).toMatch(/\.in\("asset_id", failingAssetIds\)/);
  });

  it("never reaches for the RLS-bypassing admin client", () => {
    expect(SERVICE).not.toMatch(/createAdminClient|supabase\/admin/);
  });

  it("is structurally read-only — the client type exposes no write verb", () => {
    const clientType = SERVICE.slice(
      SERVICE.indexOf("type OperationsBuilder"),
      SERVICE.indexOf("export const RECENT_COMPLETION_DAYS"),
    );
    for (const verb of ["insert", "update", "upsert", "delete", "rpc"]) {
      expect(clientType, `OperationsBuilder must not expose ${verb}`).not.toMatch(
        new RegExp(`\\b${verb}\\s*:`),
      );
    }
  });

  it("issues no write statement anywhere in the service", () => {
    expect(SERVICE).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(|\.rpc\(/);
  });
});

describe("the composition layer owns no data access and no new rules", () => {
  it("performs no I/O at all", () => {
    expect(COMPOSE).not.toMatch(/createClient|supabase|fetch\(|from\("/);
  });

  it("takes its clock from the caller rather than reading one", () => {
    expect(COMPOSE).not.toMatch(/Date\.now\(\)|new Date\(\)/);
    expect(COMPOSE).toMatch(/todayIso: string/);
    expect(COMPOSE).toMatch(/nowIso: string/);
  });

  it("delegates every judgement to the domain lib that already owns it", () => {
    const required: Array<[string, string]> = [
      ["isActiveCase", "@/lib/assets/maintenance"],
      ["isInspectionOverdue", "@/lib/assets/inspection-schedule"],
      ["currentSafetyBlocks", "@/lib/assets/inspection-override"],
      ["hasUnbypassedBlock", "@/lib/assets/inspection-override"],
      ["isDisposed", "@/lib/assets/schema"],
    ];
    for (const [symbol, from] of required) {
      expect(COMPOSE, `${symbol} must be imported from ${from}`).toMatch(
        new RegExp(`\\b${symbol}\\b`),
      );
      expect(COMPOSE).toContain(from);
    }
    // Custody lateness is imported under an alias, so assert the import itself.
    expect(COMPOSE).toMatch(/isOverdue as isCustodyOverdue.*from "@\/lib\/assets\/assignment"/);
  });

  it("re-implements none of those rules locally", () => {
    // A literal date comparison or a severity ladder in the CODE would be a
    // second opinion on a question a tested lib already answers. The imminent
    // band must be read off `severity`, which conflictSeverity stamped, rather
    // than re-derived from `daysAway`.
    const body = code(COMPOSE);
    expect(body).not.toMatch(/severity\s*[=:]\s*["']critical["']/);
    expect(body).not.toMatch(/daysAway/);
    expect(body).not.toMatch(/expected_return_at\s*[<>]/);
    expect(body).not.toMatch(/due_at\s*[<>]/);
    expect(body).toMatch(/c\.severity === "high"/);
  });
});

describe("the page hands the active org in and stays read-only", () => {
  it("resolves the org context and passes ctx.org.id to the snapshot", () => {
    expect(PAGE).toMatch(/const \{ ctx \} = await requireOrgContext\(\)/);
    expect(PAGE).toMatch(/buildOperationsSnapshot\(ctx\.org\.id\)/);
  });

  it("never reads the database directly, so it cannot skip the pinned service", () => {
    expect(PAGE).not.toMatch(/createClient|createAdminClient|\.from\(/);
  });

  it("declares no server action and submits no form", () => {
    expect(PAGE).not.toMatch(/["']use server["']/);
    expect(PAGE).not.toMatch(/<form\b/);
    expect(PAGE).not.toMatch(/<button\b/);
  });

  it("gates the admin-only maintenance figure on the caller's own role", () => {
    // asset_maintenance_case_costs is admin-only at the DB (20261002), so a
    // member's figure is 0 by construction. The label must say so rather than
    // implying the fleet costs nothing to maintain.
    expect(PAGE).toMatch(/ctx\.membership\.role === "owner" \|\| ctx\.membership\.role === "admin"/);
    expect(PAGE).toMatch(/Visible to owners and admins only/);
  });
});

describe("the Operations route is reachable and correctly placed", () => {
  it("is in the admin nav and not the staff one", () => {
    // Product UX rebuild: nav is defined in the shared model, filtered by role.
    // Operations is an owner/admin area; staff never see it (they get the field
    // areas only). This mirrors the guard that /operations serves admin data.
    const adminHrefs = navForRole("owner").flatMap((a) => [
      a.href,
      ...a.children.map((c) => c.href),
    ]);
    const staffHrefs = navForRole("staff").flatMap((a) => [
      a.href,
      ...a.children.map((c) => c.href),
    ]);
    expect(adminHrefs).toContain("/operations");
    expect(staffHrefs).not.toContain("/operations");
  });

  it("ships a route-level skeleton so the heaviest read never blanks the shell", () => {
    expect(() => src("app/(app)/operations/loading.tsx")).not.toThrow();
  });
});
