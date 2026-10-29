import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Role & Permissions R4 — invoices module capability enforcement.
 *
 * Proves (a) every invoices surface (segment layout + the /api/invoices routes)
 * is gated by the `invoices` capability with the correct action, and (b) the
 * underlying requireCapability / requireCapabilityApi primitives enforce the
 * founder's rule: OWNER always passes (unrestricted in their org), an ADMIN
 * passes ONLY with the granted capability (default-deny), and staff/unknown are
 * denied. Positive + negative, per the mandate.
 *
 * Scope note: v1/* (public API-key auth) and cron/* (shared-secret) are a
 * different auth model and are intentionally untouched; payment/proof actions
 * belong to the `payments` module (next R4 PR) and keep requireManagement until
 * then (not weaker).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ── A. source contracts — each surface wired to invoices:<action> ────────────
describe("invoices surfaces are gated by the invoices capability", () => {
  const SURFACES: Array<{ file: string; expect: Array<[string, string]> }> = [
    { file: "app/(app)/invoices/layout.tsx", expect: [["view", "layout"]] },
    { file: "app/api/invoices/route.ts", expect: [["view", "GET"], ["create", "POST"]] },
    { file: "app/api/invoices/[id]/route.ts", expect: [["edit", "PATCH"], ["delete", "DELETE"]] },
    { file: "app/api/invoices/export/route.ts", expect: [["export", "GET"]] },
    { file: "app/api/invoices/[id]/pdf/route.ts", expect: [["view", "GET"]] },
    { file: "app/api/invoices/[id]/remind/route.ts", expect: [["edit", "POST"]] },
    { file: "app/api/invoices/[id]/send/route.ts", expect: [["edit", "POST"]] },
  ];

  for (const s of SURFACES) {
    it(`${s.file} is invoices-capability gated with no residual management gate`, () => {
      const code = codeOf(read(s.file));
      // The old binary gate is gone from this surface.
      expect(code, "no requireManagement* left").not.toMatch(/requireManagement(Api|Context|Role)/);
      // Every action we expect is present as an invoices capability call.
      for (const [action] of s.expect) {
        expect(code, `must gate an "${action}" path`).toMatch(
          new RegExp(`requireCapability(Api)?\\(\\s*"invoices",\\s*"${action}"\\s*\\)`),
        );
      }
    });
  }
});

// ── B. behavioural — the primitives enforce owner/admin-grant/deny ───────────
let mockRole: string | null = "owner";
let mockGrants: Array<{ module: string; action: string }> = [];

vi.mock("@/server/auth/session", () => ({
  requireOrgContext: vi.fn(async () => ({
    user: { id: "user-1" },
    ctx: { membership: { org_id: "org-1", role: mockRole }, org: { id: "org-1" } },
  })),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
// The admin client loadCapabilities uses: memberships(role) then the grants.
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

const { requireCapabilityApi, requireCapability } = await import("@/server/auth/capabilities");

beforeEach(() => {
  mockRole = "owner";
  mockGrants = [];
});

describe("requireCapabilityApi — owner full, admin granted-only, deny-default", () => {
  it("OWNER passes with NO stored grants (unrestricted in their org)", async () => {
    mockRole = "owner";
    mockGrants = [];
    const res = await requireCapabilityApi("invoices", "delete");
    expect(res).not.toBeInstanceOf(Response);
  });

  it("ADMIN with invoices:view passes view, but is DENIED edit (not granted)", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "invoices", action: "view" }];
    expect(await requireCapabilityApi("invoices", "view")).not.toBeInstanceOf(Response);
    const denied = await requireCapabilityApi("invoices", "edit");
    expect(denied).toBeInstanceOf(Response);
    expect((denied as Response).status).toBe(403);
  });

  it("ADMIN with NO invoices grant is DENIED (default-deny, 403)", async () => {
    mockRole = "admin";
    mockGrants = [];
    const denied = await requireCapabilityApi("invoices", "view");
    expect(denied).toBeInstanceOf(Response);
    expect((denied as Response).status).toBe(403);
  });

  it("ADMIN with invoices:manage passes every invoices action", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "invoices", action: "manage" }];
    for (const a of ["view", "create", "edit", "delete", "export"] as const) {
      expect(await requireCapabilityApi("invoices", a)).not.toBeInstanceOf(Response);
    }
  });

  it("STAFF is denied even with a stray grant row (no management capability)", async () => {
    mockRole = "staff";
    mockGrants = [{ module: "invoices", action: "view" }];
    expect(await requireCapabilityApi("invoices", "view")).toBeInstanceOf(Response);
  });
});

describe("requireCapability (page) redirects a denied caller", () => {
  it("redirects an admin without the grant", async () => {
    mockRole = "admin";
    mockGrants = [];
    await expect(requireCapability("invoices", "view")).rejects.toThrowError(
      /NEXT_REDIRECT:\/dashboard\?error=forbidden/,
    );
  });
  it("lets the owner through", async () => {
    mockRole = "owner";
    await expect(requireCapability("invoices", "view")).resolves.toBeTruthy();
  });
});
