import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Role & Permissions R4 — tax module capability enforcement.
 *
 * The /tax dashboard (VAT / CIS300 / PAYE) + HMRC prepare/submit wire-up is
 * management/financial end-to-end — NO member-open surface. Gates:
 *   page (dashboard)                → tax:view
 *   prepareVatReturnAction          → tax:create
 *   prepareCis300ReturnAction       → tax:create
 *   submitHmrcReturnAction          → tax:manage  (filing a legal return to HMRC
 *                                      is the highest-trust tax action)
 *   GET /api/tax/quarterly-pdf       → tax:view
 *
 * The 3 server actions are plain FormData→void form-actions that THROW with a
 * plain reason on denial (not a FormState, not a redirect), so they gate with
 * the boolean `hasCapability` and throw on false. The admin-insert RLS on
 * hmrc_submissions / hmrc_connections remains the floor; submitting is ALSO
 * doubly dark-gated (isHmrcConnectable). Positive + negative + per-action.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("tax surfaces are capability-gated with the right action", () => {
  it("the dashboard page requires tax:view, no residual management gate", () => {
    const code = codeOf(read("app/(app)/tax/page.tsx"));
    expect(code).toMatch(/requireCapability\(\s*"tax",\s*"view"\s*\)/);
    expect(code).not.toMatch(/requireManagement(Role|Context|Api)/);
  });

  it("actions.ts gates every action via hasCapability and throws on deny, no residual isAdminRole", () => {
    const code = codeOf(read("app/(app)/tax/actions.ts"));
    expect(code).not.toMatch(/\bisAdminRole\b/);
    expect(code).not.toMatch(/requireManagement(Role|Context|Api)/);
    // prepare VAT + CIS300 → create (>=2); submit → manage (>=1).
    expect((code.match(/hasCapability\([^)]*"tax",\s*"create"\s*\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((code.match(/hasCapability\([^)]*"tax",\s*"manage"\s*\)/g) ?? []).length).toBeGreaterThanOrEqual(1);
    // Denial path throws (plain form-action contract), it does not redirect.
    expect(code).toMatch(/if \(!\(await hasCapability\([^)]*\)\)\)\s*\{\s*throw new Error/);
    expect(code).not.toMatch(/redirect\(/);
  });

  it("the quarterly PDF route gates via requireCapabilityApi(tax:view)", () => {
    const code = codeOf(read("app/api/tax/quarterly-pdf/route.ts"));
    expect(code).toMatch(/requireCapabilityApi\(\s*"tax",\s*"view"\s*\)/);
    expect(code).not.toMatch(/requireManagementApi/);
  });

  it("the page affordances mirror the grants (canWith), not a raw owner/admin check", () => {
    // Prevent the UX regression where a tax:view-only admin sees Prepare/Submit
    // buttons that throw on click: canPrepare → tax:create, canSubmit → tax:manage,
    // both via canWith against the caller's grants (nav-hiding is never the
    // boundary, but it must agree with the server gate).
    const code = codeOf(read("app/(app)/tax/page.tsx"));
    expect(code).toMatch(/canPrepare = canWith\([^)]*"tax",\s*"create"\s*\)/);
    expect(code).toMatch(/canWith\([^)]*"tax",\s*"manage"\s*\)/);
    // The coarse role-based affordance is gone.
    expect(code).not.toMatch(/canPrepare\s*=\s*[\s\S]{0,40}role === "owner"/);
  });
});

// =====================================================================
// Behavioural — the actions + PDF route enforce distinct capabilities.
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

describe("tax server-action capability (hasCapability — boolean, throws on deny)", () => {
  it("an admin with tax:create can prepare but CANNOT submit (manage)", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "tax", action: "create" }];
    expect(await hasCapability(CTX("admin"), USER, "tax", "create")).toBe(true);
    expect(await hasCapability(CTX("admin"), USER, "tax", "manage")).toBe(false);
  });

  it("an admin with tax:manage can do every action (manage broadens)", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "tax", action: "manage" }];
    for (const action of ["view", "create", "manage"] as const) {
      expect(await hasCapability(CTX("admin"), USER, "tax", action), action).toBe(true);
    }
  });

  it("the owner can prepare and submit without any stored grant", async () => {
    mockRole = "owner";
    mockGrants = [];
    for (const action of ["view", "create", "manage"] as const) {
      expect(await hasCapability(CTX("owner"), USER, "tax", action), action).toBe(true);
    }
  });

  it("staff / member cannot prepare or submit, even with a stray grant", async () => {
    for (const role of ["staff", "member"] as const) {
      mockRole = role;
      mockGrants = [{ module: "tax", action: "manage" }];
      for (const action of ["view", "create", "manage"] as const) {
        expect(await hasCapability(CTX(role), USER, "tax", action), `${role}:${action}`).toBe(false);
      }
    }
  });
});

describe("tax PDF route capability (requireCapabilityApi — 403 Response)", () => {
  it("needs tax:view — a granted admin passes, an ungranted admin 403s, owner always passes", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "tax", action: "view" }];
    expect(await requireCapabilityApi("tax", "view")).not.toBeInstanceOf(Response);
    mockGrants = [{ module: "tax", action: "create" }]; // create, not view
    const denied = await requireCapabilityApi("tax", "view");
    expect(denied).toBeInstanceOf(Response);
    expect((denied as Response).status).toBe(403);
    mockRole = "owner";
    mockGrants = [];
    expect(await requireCapabilityApi("tax", "view")).not.toBeInstanceOf(Response);
  });
});
