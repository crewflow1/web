import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Role & Permissions R4 — cash module capability enforcement.
 *
 * The /cash position page (collectable money-in minus money owed) is sensitive
 * financial data — management-only, no member-open surface. It is a single page
 * (no API, no actions, no layout):
 *   page → cash:view
 *
 * Previously it used requireOrgContext + an inline `role === "staff"` redirect.
 * R4 swaps that for requireCapability("cash","view") — owner full; admin only if
 * granted; staff never. The money-OUT visibility stays gated by
 * cashOutVisibleToRole as defence-in-depth (never overstate payables for a role
 * without admin-ledger access). RLS on the underlying ledgers remains the floor.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("cash page is capability-gated at cash:view", () => {
  it("gates via requireCapability(cash:view), no residual management/staff-role gate", () => {
    const code = codeOf(read("app/(app)/cash/page.tsx"));
    expect(code).toMatch(/requireCapability\(\s*"cash",\s*"view"\s*\)/);
    expect(code).not.toMatch(/requireManagement(Role|Context|Api)/);
    // The old inline staff-redirect gate is gone (the capability gate subsumes it).
    expect(code).not.toMatch(/role === "staff"/);
  });

  it("keeps the money-out overstatement safety net (cashOutVisibleToRole)", () => {
    const code = codeOf(read("app/(app)/cash/page.tsx"));
    expect(code).toMatch(/cashOutVisibleToRole\(/);
  });
});

// Behavioural — cash:view enforced by role/grant.
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

describe("cash:view is enforced by owner / grant / role", () => {
  it("owner passes with no stored grant", async () => {
    mockRole = "owner";
    await expect(requireCapabilityFor(CTX("owner"), USER, "cash", "view")).resolves.toBeUndefined();
  });
  it("an admin with cash:view passes; an admin without it is denied", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "cash", action: "view" }];
    await expect(requireCapabilityFor(CTX("admin"), USER, "cash", "view")).resolves.toBeUndefined();
    mockGrants = [{ module: "reports", action: "view" }]; // unrelated grant
    await expect(requireCapabilityFor(CTX("admin"), USER, "cash", "view")).rejects.toThrowError(/NEXT_REDIRECT/);
  });
  it("staff is denied even with a stray cash grant", async () => {
    mockRole = "staff";
    mockGrants = [{ module: "cash", action: "view" }];
    await expect(requireCapabilityFor(CTX("staff"), USER, "cash", "view")).rejects.toThrowError(/NEXT_REDIRECT/);
  });
});
