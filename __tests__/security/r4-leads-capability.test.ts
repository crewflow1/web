import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Role & Permissions R4 — leads module capability enforcement.
 *
 * The sales pipeline (value/forecast) is a management-only area. Gates:
 *   layout + list page      → leads:view
 *   createLead              → leads:create
 *   convertLeadToCustomer   → leads:create  (creates a customer from the lead)
 *   updateLead              → leads:edit
 *   moveLeadStage           → leads:edit
 *   acknowledgeLead         → leads:edit
 *   regenerateLeadSummary   → leads:edit
 *   deleteLead              → leads:delete
 *
 * No API routes. Positive + negative + per-action.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("leads surfaces are capability-gated with the right action", () => {
  it("layout + list page require leads:view, no residual management gate", () => {
    for (const f of ["app/(app)/leads/layout.tsx", "app/(app)/leads/page.tsx"]) {
      const code = codeOf(read(f));
      expect(code, `${f} view gate`).toMatch(/requireCapability\(\s*"leads",\s*"view"\s*\)/);
      expect(code, `${f} no residual`).not.toMatch(/requireManagement(Role|Context|Api)/);
    }
  });

  it("actions.ts maps each verb correctly, no residual management gate", () => {
    const code = codeOf(read("app/(app)/leads/actions.ts"));
    expect(code).not.toMatch(/requireManagement(Role|Context|Api)/);
    const n = (action: string) =>
      (code.match(new RegExp(`requireCapabilityFor\\(ctx, user, "leads", "${action}"\\)`, "g")) ?? []).length;
    // create: createLead + convertLeadToCustomer (>=2); edit: update/move/ack/
    // regenerate (>=4); delete: deleteLead (>=1).
    expect(n("create"), "create").toBeGreaterThanOrEqual(2);
    expect(n("edit"), "edit").toBeGreaterThanOrEqual(4);
    expect(n("delete"), "delete").toBeGreaterThanOrEqual(1);
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

describe("leads actions are distinct capabilities", () => {
  it("an admin with leads:edit can edit but CANNOT create / delete", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "leads", action: "edit" }];
    await expect(requireCapabilityFor(CTX("admin"), USER, "leads", "edit")).resolves.toBeUndefined();
    for (const action of ["create", "delete"] as const) {
      await expect(
        requireCapabilityFor(CTX("admin"), USER, "leads", action),
      ).rejects.toThrowError(/NEXT_REDIRECT/);
    }
  });

  it("an admin with leads:manage can do every action", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "leads", action: "manage" }];
    for (const action of ["view", "create", "edit", "delete"] as const) {
      await expect(
        requireCapabilityFor(CTX("admin"), USER, "leads", action),
      ).resolves.toBeUndefined();
    }
  });

  it("the owner can do everything without any stored grant", async () => {
    mockRole = "owner";
    mockGrants = [];
    for (const action of ["view", "create", "edit", "delete"] as const) {
      await expect(
        requireCapabilityFor(CTX("owner"), USER, "leads", action),
      ).resolves.toBeUndefined();
    }
  });

  it("staff / member are denied every leads action, even with a stray grant", async () => {
    for (const role of ["staff", "member"] as const) {
      mockRole = role;
      mockGrants = [{ module: "leads", action: "manage" }];
      for (const action of ["view", "create", "edit", "delete"] as const) {
        await expect(
          requireCapabilityFor(CTX(role), USER, "leads", action),
          `${role}:${action}`,
        ).rejects.toThrowError(/NEXT_REDIRECT/);
      }
    }
  });
});
