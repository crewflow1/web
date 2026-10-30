import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Role & Permissions R4 — insights intelligence surface capability enforcement.
 *
 * /insights is management business intelligence over financial data (activity,
 * lead analytics, company health, forecasts, cash position) — the "financial
 * reports" class staff are barred from. /api/ai/question answers questions over
 * the SAME financial snapshot (invoiced totals/counts). Both are gated on
 * reports:view — the data-visibility boundary — rather than the coarse
 * management role:
 *   app/(app)/insights/page.tsx   → requireCapability("reports","view")
 *   app/api/ai/question/route.ts  → requireCapabilityApi("reports","view")
 *
 * Rationale pinned here so a future refactor can't silently regress the money
 * boundary: the AI inherits the requesting user's permission to the underlying
 * data; it is NOT governed by a generic "ai" grant (that would let an admin with
 * only ai access read invoiced financial totals). AI *cost* is a separate
 * concern handled by the cost governor.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("insights surface is gated on reports:view (not the coarse management role)", () => {
  it("the /insights page requires reports:view", () => {
    const code = codeOf(read("app/(app)/insights/page.tsx"));
    expect(code).toMatch(/requireCapability\(\s*"reports",\s*"view"\s*\)/);
    expect(code).not.toMatch(/requireManagement(Role|Context|Api)/);
  });

  it("POST /api/ai/question gates on reports:view via requireCapabilityApi", () => {
    const code = codeOf(read("app/api/ai/question/route.ts"));
    expect(code).toMatch(/requireCapabilityApi\(\s*"reports",\s*"view"\s*\)/);
    expect(code).not.toMatch(/requireManagementApi/);
    // Must NOT be gated on a bare "ai" capability — that would bypass the money
    // boundary (an ai-only admin could read invoiced financial totals).
    expect(code).not.toMatch(/requireCapabilityApi\(\s*"ai"/);
    // The denied-caller 403 bail must remain.
    expect(code).toMatch(/guard instanceof Response/);
  });
});

// =====================================================================
// Behavioural — reports:view semantics gate the surface. Mirrors the reports
// module: owner all; admin only with the grant (or manage/wildcard); staff
// denied even with a stray grant. Only the admin-client grant read is mocked.
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

describe("insights/ai-question inherit reports:view semantics", () => {
  it("an admin with reports:view is allowed", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "reports", action: "view" }];
    await expect(
      requireCapabilityFor(CTX("admin"), USER, "reports", "view"),
    ).resolves.toBeUndefined();
  });

  it("an admin with ONLY an ai grant is denied (money boundary holds)", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "ai", action: "manage" }];
    await expect(
      requireCapabilityFor(CTX("admin"), USER, "reports", "view"),
    ).rejects.toThrowError(/NEXT_REDIRECT/);
  });

  it("an admin with no grants is denied", async () => {
    mockRole = "admin";
    mockGrants = [];
    await expect(
      requireCapabilityFor(CTX("admin"), USER, "reports", "view"),
    ).rejects.toThrowError(/NEXT_REDIRECT/);
  });

  it("the owner is allowed without any stored grant", async () => {
    mockRole = "owner";
    mockGrants = [];
    await expect(
      requireCapabilityFor(CTX("owner"), USER, "reports", "view"),
    ).resolves.toBeUndefined();
  });

  it("staff are denied even with a stray reports grant", async () => {
    mockRole = "staff";
    mockGrants = [{ module: "reports", action: "manage" }];
    await expect(
      requireCapabilityFor(CTX("staff"), USER, "reports", "view"),
    ).rejects.toThrowError(/NEXT_REDIRECT/);
  });
});
