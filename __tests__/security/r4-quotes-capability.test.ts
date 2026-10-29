import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Role & Permissions R4 — quotes module capability enforcement.
 *
 * The Quotes area is gated at the layout (quotes:view); the 12 management
 * actions re-check with the right action; the API routes re-check:
 *   layout + list page              → quotes:view
 *   createQuote / duplicate / createVariation            → quotes:create
 *   updateQuote / sendQuote / requestQuoteApproval /
 *     recordVariationEotAgreement / reclassify…Eot        → quotes:edit
 *   reviewQuote / acceptQuoteAsOwner / declineQuoteAsOwner → quotes:approve
 *   deleteQuote                                           → quotes:delete
 *   GET /api/quotes/[id]/pdf          → quotes:view
 *   POST /api/quotes/[id]/send        → quotes:edit
 *
 * Customer token actions (acceptQuoteByToken / declineQuoteByToken) are the
 * public-portal path and are NOT capability-gated — they authenticate by the
 * quote's public token, not an org membership. Positive + negative + per-action.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("quotes surfaces are capability-gated with the right action", () => {
  it("layout + list page require quotes:view, no residual management gate", () => {
    for (const f of ["app/(app)/quotes/layout.tsx", "app/(app)/quotes/page.tsx"]) {
      const code = codeOf(read(f));
      expect(code, `${f} view gate`).toMatch(/requireCapability\(\s*"quotes",\s*"view"\s*\)/);
      expect(code, `${f} no residual`).not.toMatch(/requireManagement(Role|Context|Api)/);
    }
  });

  it("actions.ts gates every management action via requireCapabilityFor, no residual management gate", () => {
    const code = codeOf(read("app/(app)/quotes/actions.ts"));
    expect(code).not.toMatch(/requireManagement(Role|Context|Api)/);
    // create (createQuote + duplicate + createVariation) ≥ 3; edit (update, send,
    // requestApproval, recordEot, reclassify) ≥ 5; approve (review, accept,
    // decline) ≥ 3; delete ≥ 1.
    const n = (action: string) =>
      (code.match(new RegExp(`requireCapabilityFor\\(ctx, user, "quotes", "${action}"\\)`, "g")) ?? []).length;
    expect(n("create"), "create").toBeGreaterThanOrEqual(3);
    expect(n("edit"), "edit").toBeGreaterThanOrEqual(5);
    expect(n("approve"), "approve").toBeGreaterThanOrEqual(3);
    expect(n("delete"), "delete").toBeGreaterThanOrEqual(1);
  });

  it("the API routes gate pdf→view and send→edit", () => {
    expect(codeOf(read("app/api/quotes/[id]/pdf/route.ts"))).toMatch(
      /requireCapabilityApi\(\s*"quotes",\s*"view"\s*\)/,
    );
    expect(codeOf(read("app/api/quotes/[id]/send/route.ts"))).toMatch(
      /requireCapabilityApi\(\s*"quotes",\s*"edit"\s*\)/,
    );
  });

  it("the customer token actions are NOT capability-gated (public-portal path)", () => {
    const code = codeOf(read("app/(app)/quotes/actions.ts"));
    // Isolate each token action body and assert it holds no org-capability gate.
    for (const fn of ["acceptQuoteByToken", "declineQuoteByToken"]) {
      const start = code.indexOf(`export async function ${fn}`);
      expect(start, `${fn} exists`).toBeGreaterThanOrEqual(0);
      const next = code.indexOf("export async function ", start + 1);
      const body = code.slice(start, next === -1 ? undefined : next);
      expect(body, `${fn} must not capability-gate`).not.toMatch(/requireCapabilityFor\([^)]*"quotes"/);
    }
  });
});

// =====================================================================
// Behavioural — the actions enforce distinct capabilities via canWith.
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

describe("quotes actions are distinct capabilities", () => {
  it("an admin with quotes:create can create but CANNOT edit / approve / delete", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "quotes", action: "create" }];
    await expect(requireCapabilityFor(CTX("admin"), USER, "quotes", "create")).resolves.toBeUndefined();
    for (const action of ["edit", "approve", "delete"] as const) {
      await expect(
        requireCapabilityFor(CTX("admin"), USER, "quotes", action),
      ).rejects.toThrowError(/NEXT_REDIRECT/);
    }
  });

  it("an admin with quotes:approve can approve but CANNOT create / delete", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "quotes", action: "approve" }];
    await expect(requireCapabilityFor(CTX("admin"), USER, "quotes", "approve")).resolves.toBeUndefined();
    for (const action of ["create", "delete"] as const) {
      await expect(
        requireCapabilityFor(CTX("admin"), USER, "quotes", action),
      ).rejects.toThrowError(/NEXT_REDIRECT/);
    }
  });

  it("an admin with quotes:manage can do every action (manage broadens)", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "quotes", action: "manage" }];
    for (const action of ["view", "create", "edit", "approve", "delete"] as const) {
      await expect(
        requireCapabilityFor(CTX("admin"), USER, "quotes", action),
      ).resolves.toBeUndefined();
    }
  });

  it("the owner can do everything without any stored grant", async () => {
    mockRole = "owner";
    mockGrants = [];
    for (const action of ["view", "create", "edit", "approve", "delete"] as const) {
      await expect(
        requireCapabilityFor(CTX("owner"), USER, "quotes", action),
      ).resolves.toBeUndefined();
    }
  });

  it("staff / member are denied every quotes action, even with a stray grant", async () => {
    for (const role of ["staff", "member"] as const) {
      mockRole = role;
      mockGrants = [{ module: "quotes", action: "manage" }];
      for (const action of ["view", "create", "edit", "approve", "delete"] as const) {
        await expect(
          requireCapabilityFor(CTX(role), USER, "quotes", action),
          `${role}:${action}`,
        ).rejects.toThrowError(/NEXT_REDIRECT/);
      }
    }
  });
});
