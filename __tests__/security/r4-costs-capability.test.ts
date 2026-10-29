import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Role & Permissions R4 — costs module capability enforcement.
 *
 * "Costs" is the UI label for the `/finances` route. The cost LEDGER is gated:
 *   page (list)        → costs:view
 *   GET  /api/finances → costs:view
 *   PATCH /api/finances/[id] → costs:edit
 *   DELETE /api/finances/[id] → costs:delete
 *   GET  /api/finances/export → costs:export
 *
 * The cost ENTRY path is DELIBERATELY member-open and MUST stay so — field
 * staff log costs from the job page (`/finances/new` + POST /api/finances),
 * the documented Money-authz split. These tests pin BOTH: that every ledger
 * surface carries the right capability, AND that the entry surfaces are not
 * newly gated (a regression that would lock field staff out of logging costs).
 * Positive + negative, incl. per-action granularity.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("cost ledger surfaces are capability-gated with the right action", () => {
  it("the ledger page requires costs:view, no residual management gate", () => {
    const code = codeOf(read("app/(app)/finances/page.tsx"));
    expect(code).toMatch(/requireCapability\(\s*"costs",\s*"view"\s*\)/);
    expect(code).not.toMatch(/requireManagement(Role|Context|Api)/);
  });

  const API: Array<{ file: string; gates: Array<[string, string]> }> = [
    { file: "app/api/finances/route.ts", gates: [["costs", "view"]] },
    { file: "app/api/finances/[id]/route.ts", gates: [["costs", "edit"], ["costs", "delete"]] },
    { file: "app/api/finances/export/route.ts", gates: [["costs", "export"]] },
  ];
  for (const { file, gates } of API) {
    it(`${file} gates via requireCapabilityApi with the right action(s)`, () => {
      const code = codeOf(read(file));
      expect(code).not.toMatch(/requireManagementApi/);
      for (const [mod, action] of gates) {
        expect(code, `${mod}:${action}`).toMatch(
          new RegExp(`requireCapabilityApi\\(\\s*"${mod}",\\s*"${action}"\\s*\\)`),
        );
      }
    });
  }
});

describe("cost ENTRY stays member-open (no capability regression)", () => {
  it("POST /api/finances is NOT capability-gated — it uses requireOrgContext", () => {
    const code = codeOf(read("app/api/finances/route.ts"));
    // The POST half (create) must remain on the member floor, never promoted to
    // a management/capability gate. Pin the create path on requireOrgContext.
    const postIdx = code.indexOf("export async function POST");
    expect(postIdx).toBeGreaterThanOrEqual(0);
    const postBody = code.slice(postIdx);
    expect(postBody).toMatch(/requireOrgContext\(\)/);
    expect(postBody).not.toMatch(/requireCapabilityApi/);
  });

  it("/finances/new (entry form) carries no capability symbol and stays member-open", () => {
    const code = codeOf(read("app/(app)/finances/new/page.tsx"));
    expect(code).toMatch(/requireOrgContext\(\)/);
    expect(code).not.toMatch(
      /requireCapability\b|requireCapabilityApi|requireManagement(Role|Context|Api)/,
    );
  });
});

// =====================================================================
// Behavioural — each ledger action is enforced distinctly via canWith().
// Mirrors the expenses suite: requireCapabilityFor takes ctx+user as args,
// so the only dependency to mock is the admin-client grant read.
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
const { requireCapabilityFor } = await import("@/server/auth/capabilities");
const CTX = (role: string | null) =>
  ({ membership: { org_id: "o", role }, org: { id: "o" } }) as never;
const USER = { id: "u" } as never;

beforeEach(() => {
  mockRole = "owner";
  mockGrants = [];
});

describe("costs actions are distinct capabilities", () => {
  it("an admin with costs:view can view but CANNOT edit / delete / export", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "costs", action: "view" }];
    await expect(requireCapabilityFor(CTX("admin"), USER, "costs", "view")).resolves.toBeUndefined();
    for (const action of ["edit", "delete", "export"] as const) {
      await expect(
        requireCapabilityFor(CTX("admin"), USER, "costs", action),
      ).rejects.toThrowError(/NEXT_REDIRECT/);
    }
  });

  it("an admin with costs:manage can view, edit, delete and export", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "costs", action: "manage" }];
    for (const action of ["view", "edit", "delete", "export"] as const) {
      await expect(
        requireCapabilityFor(CTX("admin"), USER, "costs", action),
      ).resolves.toBeUndefined();
    }
  });

  it("the owner can do everything without any stored grant", async () => {
    mockRole = "owner";
    mockGrants = [];
    for (const action of ["view", "edit", "delete", "export"] as const) {
      await expect(
        requireCapabilityFor(CTX("owner"), USER, "costs", action),
      ).resolves.toBeUndefined();
    }
  });

  it("staff are denied the cost ledger entirely, even with a stray grant", async () => {
    mockRole = "staff";
    mockGrants = [{ module: "costs", action: "manage" }];
    await expect(
      requireCapabilityFor(CTX("staff"), USER, "costs", "view"),
    ).rejects.toThrowError(/NEXT_REDIRECT/);
  });
});
