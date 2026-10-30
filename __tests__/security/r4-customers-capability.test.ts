import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Role & Permissions R4 — customers module capability enforcement.
 *
 * Customers carries financial rollups — management-only area. Gates:
 *   layout + list page              → customers:view
 *   createCustomer                  → customers:create
 *   updateCustomer                  → customers:edit
 *   rotateCustomerPortalToken       → customers:edit   (reissues portal access)
 *   sendCustomerStatement           → customers:export (emails a financial statement out)
 *   deleteCustomer                  → customers:delete
 *   GET /api/customers/[id]/statement/pdf → customers:view
 *
 * Staff reach a specific customer/site only through an assigned job (enforced
 * separately, R5) — never this management area. Positive + negative + per-action.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("customers surfaces are capability-gated with the right action", () => {
  it("layout + list page require customers:view, no residual management gate", () => {
    for (const f of ["app/(app)/customers/layout.tsx", "app/(app)/customers/page.tsx"]) {
      const code = codeOf(read(f));
      expect(code, `${f} view gate`).toMatch(/requireCapability\(\s*"customers",\s*"view"\s*\)/);
      expect(code, `${f} no residual`).not.toMatch(/requireManagement(Role|Context|Api)/);
    }
  });

  it("actions.ts maps each verb correctly, no residual management gate", () => {
    const code = codeOf(read("app/(app)/customers/actions.ts"));
    expect(code).not.toMatch(/requireManagement(Role|Context|Api)/);
    const has = (action: string) =>
      new RegExp(`requireCapabilityFor\\(ctx, user, "customers", "${action}"\\)`).test(code);
    expect(has("create"), "create").toBe(true);
    expect(has("delete"), "delete").toBe(true);
    expect(has("export"), "export (sendCustomerStatement)").toBe(true);
    // edit appears for updateCustomer + rotateCustomerPortalToken (>=2).
    expect((code.match(/requireCapabilityFor\(ctx, user, "customers", "edit"\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("the statement PDF route gates customers:view", () => {
    expect(codeOf(read("app/api/customers/[id]/statement/pdf/route.ts"))).toMatch(
      /requireCapabilityApi\(\s*"customers",\s*"view"\s*\)/,
    );
  });
});

// Behavioural
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
const { requireCapabilityFor } = await import("@/server/auth/capabilities");
const CTX = (role: string | null) =>
  ({ membership: { org_id: "o", role }, org: { id: "o" } }) as never;
const USER = { id: "u" } as never;

beforeEach(() => {
  mockRole = "owner";
  mockGrants = [];
});

describe("customers actions are distinct capabilities", () => {
  it("an admin with customers:edit can edit but CANNOT create / export / delete", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "customers", action: "edit" }];
    await expect(requireCapabilityFor(CTX("admin"), USER, "customers", "edit")).resolves.toBeUndefined();
    for (const action of ["create", "export", "delete"] as const) {
      await expect(
        requireCapabilityFor(CTX("admin"), USER, "customers", action),
      ).rejects.toThrowError(/NEXT_REDIRECT/);
    }
  });

  it("an admin with customers:manage can do every action", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "customers", action: "manage" }];
    for (const action of ["view", "create", "edit", "export", "delete"] as const) {
      await expect(
        requireCapabilityFor(CTX("admin"), USER, "customers", action),
      ).resolves.toBeUndefined();
    }
  });

  it("the owner can do everything without any stored grant", async () => {
    mockRole = "owner";
    mockGrants = [];
    for (const action of ["view", "create", "edit", "export", "delete"] as const) {
      await expect(
        requireCapabilityFor(CTX("owner"), USER, "customers", action),
      ).resolves.toBeUndefined();
    }
  });

  it("staff / member are denied every customers action, even with a stray grant", async () => {
    for (const role of ["staff", "member"] as const) {
      mockRole = role;
      mockGrants = [{ module: "customers", action: "manage" }];
      for (const action of ["view", "create", "edit", "export", "delete"] as const) {
        await expect(
          requireCapabilityFor(CTX(role), USER, "customers", action),
          `${role}:${action}`,
        ).rejects.toThrowError(/NEXT_REDIRECT/);
      }
    }
  });
});
