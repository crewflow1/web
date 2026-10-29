import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Role & Permissions R4 — reports module capability enforcement.
 *
 * The Reports AREA (dashboard + ageing/cashflow/pipeline/profit/retention/
 * utilisation + accounting + subscribe) is gated by the layout at reports:view.
 * Writes + exports re-check:
 *   layout (all pages)                 → reports:view
 *   GET /api/reports (index)           → reports:view
 *   GET /api/reports/export (CSV)      → reports:export
 *   requestAccountingPush              → reports:export  (financial export to provider)
 *   disconnectAccountingConnection     → reports:manage  (manage the connection)
 *   createReportSubscription           → reports:manage  (standing delivery config)
 *   deleteReportSubscription           → reports:manage
 *
 * ONE deliberate exception — the shared per-report export API
 * (/api/reports/[report]/export): a NON-management report stays member-
 * exportable; a MANAGEMENT-only report (cashflow: VAT/CIS/payables) requires
 * reports:export. These tests pin BOTH. Positive + negative + per-action.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("reports surfaces are capability-gated with the right action", () => {
  it("the layout requires reports:view, no residual management gate", () => {
    const code = codeOf(read("app/(app)/reports/layout.tsx"));
    expect(code).toMatch(/requireCapability\(\s*"reports",\s*"view"\s*\)/);
    expect(code).not.toMatch(/requireManagement(Role|Context|Api)/);
  });

  it("the accounting actions gate push→export and disconnect→manage, no residual isAdminRole", () => {
    const code = codeOf(read("app/(app)/reports/accounting/actions.ts"));
    expect(code).not.toMatch(/\bisAdminRole\b/);
    expect(code).toMatch(/hasCapability\([^)]*"reports",\s*"export"\s*\)/); // push
    expect(code).toMatch(/hasCapability\([^)]*"reports",\s*"manage"\s*\)/); // disconnect
  });

  it("the subscribe actions gate create+delete on reports:manage, no residual isAdminRole", () => {
    const code = codeOf(read("app/(app)/reports/subscribe/actions.ts"));
    expect(code).not.toMatch(/\bisAdminRole\b/);
    expect((code.match(/hasCapability\([^)]*"reports",\s*"manage"\s*\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("the index API gates reports:view and the CSV API gates reports:export", () => {
    const idx = codeOf(read("app/api/reports/route.ts"));
    expect(idx).toMatch(/requireCapabilityApi\(\s*"reports",\s*"view"\s*\)/);
    expect(idx).not.toMatch(/requireManagementApi/);
    const csv = codeOf(read("app/api/reports/export/route.ts"));
    expect(csv).toMatch(/requireCapabilityApi\(\s*"reports",\s*"export"\s*\)/);
    expect(csv).not.toMatch(/requireManagementApi/);
  });

  it("the per-report export keeps member access for non-management reports, gates management-only on reports:export", () => {
    const code = codeOf(read("app/api/reports/[report]/export/route.ts"));
    // The gate is CONDITIONAL on meta.managementOnly — non-management reports are
    // NOT newly gated (operational exception preserved), management-only ones need
    // the export capability.
    expect(code).toMatch(
      /meta\.managementOnly\s*&&\s*!\(await hasCapability\([^)]*"reports",\s*"export"\s*\)\)/,
    );
    // ctx still comes from requireOrgContext (member floor) for the open path.
    expect(code).toMatch(/requireOrgContext\(\)/);
  });
});

// =====================================================================
// Behavioural — reports actions + API routes enforce distinct capabilities.
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

describe("reports actions are distinct capabilities", () => {
  it("an admin with reports:view can view but CANNOT export or manage", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "reports", action: "view" }];
    expect(await requireCapabilityApi("reports", "view")).not.toBeInstanceOf(Response);
    const exp = await requireCapabilityApi("reports", "export");
    expect(exp).toBeInstanceOf(Response);
    expect((exp as Response).status).toBe(403);
    expect(await hasCapability(CTX("admin"), USER, "reports", "export")).toBe(false);
    expect(await hasCapability(CTX("admin"), USER, "reports", "manage")).toBe(false);
  });

  it("an admin with reports:export can export but CANNOT manage (subscriptions/disconnect)", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "reports", action: "export" }];
    expect(await hasCapability(CTX("admin"), USER, "reports", "export")).toBe(true);
    expect(await hasCapability(CTX("admin"), USER, "reports", "manage")).toBe(false);
  });

  it("an admin with reports:manage can do everything (manage broadens)", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "reports", action: "manage" }];
    for (const action of ["view", "export", "manage"] as const) {
      expect(await hasCapability(CTX("admin"), USER, "reports", action), action).toBe(true);
    }
  });

  it("the owner can do everything without any stored grant", async () => {
    mockRole = "owner";
    mockGrants = [];
    for (const action of ["view", "export", "manage"] as const) {
      expect(await hasCapability(CTX("owner"), USER, "reports", action), action).toBe(true);
    }
  });

  it("staff / member are denied reports management, even with a stray grant", async () => {
    for (const role of ["staff", "member"] as const) {
      mockRole = role;
      mockGrants = [{ module: "reports", action: "manage" }];
      for (const action of ["view", "export", "manage"] as const) {
        expect(await hasCapability(CTX(role), USER, "reports", action), `${role}:${action}`).toBe(false);
      }
    }
  });
});
