import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Role & Permissions R4 — CIS module capability enforcement.
 *
 * CIS (Construction Industry Scheme) is management/financial end-to-end — there
 * is NO member-open surface here (unlike costs/expenses entry). The gates:
 *   layout (all pages)              → cis:view
 *   saveContractorProfile           → cis:manage   (org CIS identity config)
 *   issueCisStatement               → cis:create
 *   prepareCisReturn                → cis:create
 *   withdrawCisStatement            → cis:delete
 *   exportCisReturn                 → cis:export
 *   emailCisStatements              → cis:manage   (sends statutory docs OUT to
 *                                      third parties — higher trust than export)
 *   GET /api/cis/returns/[id]/export.csv   → cis:export
 *   GET /api/cis/statements/export.csv     → cis:export
 *   GET /api/cis/statements/[id]/pdf        → cis:view
 *
 * The 6 server actions return a FormState (graceful message), so they gate with
 * the boolean `hasCapability` rather than a redirecting guard. The admin-only
 * RLS on every CIS table remains the floor; the capability gate is the granular
 * admin boundary on top (RLS `is_org_admin` admits ANY admin; the grant narrows
 * that to admins the owner authorised). Positive + negative + per-action.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("CIS surfaces are capability-gated with the right action", () => {
  it("the layout requires cis:view, no residual management gate", () => {
    const code = codeOf(read("app/(app)/cis/layout.tsx"));
    expect(code).toMatch(/requireCapability\(\s*"cis",\s*"view"\s*\)/);
    expect(code).not.toMatch(/requireManagement(Role|Context|Api)/);
  });

  it("actions.ts gates every action via hasCapability, no residual isManager/management gate", () => {
    const code = codeOf(read("app/(app)/cis/actions.ts"));
    expect(code).not.toMatch(/requireManagement(Role|Context|Api)/);
    // The old inline owner/admin helper is gone — replaced by the capability.
    expect(code).not.toMatch(/\bisManager\b/);
    // Each verb maps to its action.
    expect(code).toMatch(/hasCapability\([^)]*"cis",\s*"delete"\s*\)/); // withdraw
    // manage for saveContractorProfile + emailCisStatements (>=2); create for
    // issue + prepare (>=2); export for exportReturn only (exactly 1 — emailing
    // is manage, not export, because it sends statutory docs to third parties).
    expect((code.match(/hasCapability\([^)]*"cis",\s*"manage"\s*\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((code.match(/hasCapability\([^)]*"cis",\s*"create"\s*\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((code.match(/hasCapability\([^)]*"cis",\s*"export"\s*\)/g) ?? []).length).toBe(1);
  });

  const API: Array<{ file: string; action: string }> = [
    { file: "app/api/cis/returns/[id]/export.csv/route.ts", action: "export" },
    { file: "app/api/cis/statements/export.csv/route.ts", action: "export" },
    { file: "app/api/cis/statements/[id]/pdf/route.ts", action: "view" },
  ];
  for (const { file, action } of API) {
    it(`${file} gates via requireCapabilityApi("cis","${action}"), no residual role check`, () => {
      const code = codeOf(read(file));
      expect(code).toMatch(new RegExp(`requireCapabilityApi\\(\\s*"cis",\\s*"${action}"\\s*\\)`));
      expect(code).not.toMatch(/\bisAdminRole\b/);
      // ctx must now come from the capability guard, not a bare requireOrgContext
      // (which would leave the granular admin gate off this surface).
      expect(code).not.toMatch(/const \{[^}]*\} = await requireOrgContext\(\)/);
    });
  }
});

// =====================================================================
// Behavioural — the actions + API routes enforce distinct capabilities.
// =====================================================================
let mockRole: string | null = "owner";
let mockGrants: Array<{ module: string; action: string }> = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () =>
              table === "memberships"
                ? { data: { id: "mem-1", role: mockRole }, error: null }
                : { data: null, error: null },
          }),
          limit: async () =>
            table === "membership_permissions"
              ? { data: mockGrants, error: null }
              : { data: [], error: null },
        }),
      }),
    }),
  }),
}));
// requireCapabilityApi resolves context via requireOrgContext — stand in the
// role under test so it runs its real canWith() logic against the mocked grants.
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: async () => ({
    ctx: { org: { id: "o" }, membership: { id: "mem-1", org_id: "o", role: mockRole } },
    user: { id: "u", email: "u@test" },
  }),
}));
const { hasCapability, requireCapabilityApi } = await import("@/server/auth/capabilities");
const CTX = (role: string | null) =>
  ({ membership: { org_id: "o", role }, org: { id: "o" } }) as never;
const USER = { id: "u" } as never;

beforeEach(() => {
  mockRole = "owner";
  mockGrants = [];
});

describe("CIS server-action capability (hasCapability — boolean, graceful)", () => {
  it("an admin with cis:create can create but CANNOT delete / export / manage", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "cis", action: "create" }];
    expect(await hasCapability(CTX("admin"), USER, "cis", "create")).toBe(true);
    for (const action of ["delete", "export", "manage"] as const) {
      expect(await hasCapability(CTX("admin"), USER, "cis", action), action).toBe(false);
    }
  });

  it("an admin with cis:manage can do every action (manage broadens)", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "cis", action: "manage" }];
    for (const action of ["view", "create", "delete", "export", "manage"] as const) {
      expect(await hasCapability(CTX("admin"), USER, "cis", action), action).toBe(true);
    }
  });

  it("the owner can do everything without any stored grant", async () => {
    mockRole = "owner";
    mockGrants = [];
    for (const action of ["view", "create", "delete", "export", "manage"] as const) {
      expect(await hasCapability(CTX("owner"), USER, "cis", action), action).toBe(true);
    }
  });

  it("staff / member are denied every CIS action, even with a stray grant", async () => {
    for (const role of ["staff", "member"] as const) {
      mockRole = role;
      mockGrants = [{ module: "cis", action: "manage" }];
      for (const action of ["view", "create", "export"] as const) {
        expect(await hasCapability(CTX(role), USER, "cis", action), `${role}:${action}`).toBe(false);
      }
    }
  });
});

describe("CIS API-route capability (requireCapabilityApi — 403 Response)", () => {
  it("the statement PDF needs cis:view — a granted admin passes, an ungranted admin 403s", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "cis", action: "view" }];
    expect(await requireCapabilityApi("cis", "view")).not.toBeInstanceOf(Response);
    mockGrants = [{ module: "cis", action: "create" }]; // has create, not view
    const denied = await requireCapabilityApi("cis", "view");
    expect(denied).toBeInstanceOf(Response);
    expect((denied as Response).status).toBe(403);
  });

  it("the CSV exports need cis:export — ungranted admin 403s, owner always passes", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "cis", action: "view" }]; // view only, no export
    const denied = await requireCapabilityApi("cis", "export");
    expect(denied).toBeInstanceOf(Response);
    expect((denied as Response).status).toBe(403);
    mockRole = "owner";
    mockGrants = [];
    expect(await requireCapabilityApi("cis", "export")).not.toBeInstanceOf(Response);
  });
});
