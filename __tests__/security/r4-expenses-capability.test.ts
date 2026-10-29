import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Role & Permissions R4 — expenses module capability enforcement.
 *
 * Pages via the layout + page gate (expenses:view); server actions re-check:
 * receipt upload → create; approve/reject draft → approve (the taxonomy's
 * approval authority); budget set/delete → manage (this also CLOSES a prior
 * member-writable gap — the budget actions had no management gate). Positive +
 * negative, incl. the approve-action granularity.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("expenses surfaces are capability-gated with the right action", () => {
  it("layout + page require expenses:view, no residual management gate", () => {
    for (const f of ["app/(app)/expenses/layout.tsx", "app/(app)/expenses/page.tsx"]) {
      const code = codeOf(read(f));
      expect(code, `${f} view gate`).toMatch(/requireCapability\(\s*"expenses",\s*"view"\s*\)/);
      expect(code, `${f} no residual`).not.toMatch(/requireManagement(Role|Context|Api)/);
    }
  });

  const ACTIONS: Array<{ file: string; needs: Array<[string, string]> }> = [
    { file: "app/(app)/expenses/actions.ts", needs: [["expenses", "create"], ["expenses", "approve"]] },
    { file: "app/(app)/expenses/budgets/actions.ts", needs: [["expenses", "manage"]] },
  ];
  for (const { file, needs } of ACTIONS) {
    it(`${file} re-checks via requireCapabilityFor, no residual management gate`, () => {
      const code = codeOf(read(file));
      expect(code).not.toMatch(/requireManagementRole/);
      for (const [mod, action] of needs) {
        expect(code, `${mod}:${action}`).toMatch(
          new RegExp(`requireCapabilityFor\\([^)]*"${mod}",\\s*"${action}"\\s*\\)`),
        );
      }
    });
  }

  it("approve/reject map to the approve action (not create/edit)", () => {
    const code = codeOf(read("app/(app)/expenses/actions.ts"));
    // Both approval verbs use the approve capability; appear at least twice.
    expect((code.match(/"expenses",\s*"approve"/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

// Behavioural: the approve action is enforced DISTINCTLY from create/view.
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
              table === "memberships" ? { data: { id: "mem-1", role: mockRole }, error: null } : { data: null, error: null },
          }),
          limit: async () => (table === "membership_permissions" ? { data: mockGrants, error: null } : { data: [], error: null }),
        }),
      }),
    }),
  }),
}));
const { requireCapabilityFor } = await import("@/server/auth/capabilities");
const CTX = (role: string | null) => ({ membership: { org_id: "o", role }, org: { id: "o" } }) as never;
const USER = { id: "u" } as never;
beforeEach(() => {
  mockRole = "owner";
  mockGrants = [];
});

describe("expenses approve is a distinct capability", () => {
  it("an admin with expenses:create can create but CANNOT approve", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "expenses", action: "create" }];
    await expect(requireCapabilityFor(CTX("admin"), USER, "expenses", "create")).resolves.toBeUndefined();
    await expect(requireCapabilityFor(CTX("admin"), USER, "expenses", "approve")).rejects.toThrowError(/NEXT_REDIRECT/);
  });
  it("an admin with expenses:approve can approve; owner always can", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "expenses", action: "approve" }];
    await expect(requireCapabilityFor(CTX("admin"), USER, "expenses", "approve")).resolves.toBeUndefined();
    mockRole = "owner";
    await expect(requireCapabilityFor(CTX("owner"), USER, "expenses", "approve")).resolves.toBeUndefined();
  });
  it("staff is denied expenses entirely", async () => {
    mockRole = "staff";
    mockGrants = [{ module: "expenses", action: "manage" }];
    await expect(requireCapabilityFor(CTX("staff"), USER, "expenses", "view")).rejects.toThrowError(/NEXT_REDIRECT/);
  });
});
