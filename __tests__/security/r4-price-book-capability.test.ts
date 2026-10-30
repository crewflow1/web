import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Role & Permissions R4 — price_book module capability enforcement.
 *
 * The price book IS pricing data (the rate library a quote is built from), so it
 * is a MONEY BOUNDARY: staff/field members must never see it. Under R4 the
 * surface is gated by the price_book capability rather than a coarse management
 * role:
 *   layout (whole subtree)        → price_book:view
 *   list page                     → price_book:view
 *   /price-book/[id] (editor)     → price_book:edit
 *   createPriceBookItem           → price_book:create
 *   updatePriceBookItem           → price_book:edit
 *   setPriceBookItemActive        → price_book:edit  (archive / restore)
 *   deletePriceBookItem           → price_book:delete
 *   saveQuoteAsTemplate           → price_book:create
 *   renameQuoteTemplate           → price_book:edit
 *   deleteQuoteTemplate           → price_book:delete
 *
 * These tests pin the source shape AND prove the runtime per-action granularity
 * (owner all; granted admin per-action; ungranted / view-only admin denied the
 * write; staff denied the whole surface even with a stray grant).
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

describe("price_book page/layout surfaces are capability-gated (view), no residual mgmt gate", () => {
  it("the segment layout requires price_book:view", () => {
    const code = codeOf(read("app/(app)/price-book/layout.tsx"));
    expect(code).toMatch(/requireCapability\(\s*"price_book",\s*"view"\s*\)/);
    expect(code).not.toMatch(/requireManagement(Role|Context|Api)/);
  });

  it("the list page requires price_book:view", () => {
    const code = codeOf(read("app/(app)/price-book/page.tsx"));
    expect(code).toMatch(/requireCapability\(\s*"price_book",\s*"view"\s*\)/);
    expect(code).not.toMatch(/requireManagement(Role|Context|Api)/);
  });

  it("the [id] editor page requires price_book:edit (not just view)", () => {
    const code = codeOf(read("app/(app)/price-book/[id]/page.tsx"));
    expect(code).toMatch(/requireCapability\(\s*"price_book",\s*"edit"\s*\)/);
    expect(code).not.toMatch(/requireManagement(Role|Context|Api)/);
  });
});

describe("price_book write actions carry the right capability action", () => {
  const actions = codeOf(read("app/(app)/price-book/actions.ts"));

  it("no residual requireManagementRole remains in the actions", () => {
    expect(actions).not.toMatch(/requireManagementRole/);
  });

  // Each write function must be gated to its mapped action. We slice each
  // function body so an assertion can't be satisfied by a different function's
  // gate elsewhere in the file.
  const slice = (name: string): string => {
    const start = actions.indexOf(`export async function ${name}`);
    expect(start, `${name} present`).toBeGreaterThanOrEqual(0);
    const next = actions.indexOf("export async function ", start + 1);
    return actions.slice(start, next === -1 ? undefined : next);
  };

  const MAP: Array<[string, string]> = [
    ["createPriceBookItem", "create"],
    ["updatePriceBookItem", "edit"],
    ["setPriceBookItemActive", "edit"],
    ["deletePriceBookItem", "delete"],
    ["saveQuoteAsTemplate", "create"],
    ["renameQuoteTemplate", "edit"],
    ["deleteQuoteTemplate", "delete"],
  ];

  for (const [fn, action] of MAP) {
    it(`${fn} → price_book:${action}`, () => {
      const body = slice(fn);
      expect(body).toMatch(
        new RegExp(
          `requireCapabilityFor\\(\\s*ctx,\\s*user,\\s*"price_book",\\s*"${action}"\\s*\\)`,
        ),
      );
    });
  }

  it("deletePriceBookItem no longer relies on an inline owner/admin role check", () => {
    const body = slice("deletePriceBookItem");
    expect(body).not.toMatch(/membership\.role\s*!==\s*"owner"/);
  });
});

// =====================================================================
// Behavioural — each action is enforced distinctly via canWith(), through
// the real requireCapabilityFor. Only the admin-client grant read is mocked.
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

describe("price_book actions are distinct capabilities", () => {
  it("an admin with price_book:view can view but CANNOT create / edit / delete", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "price_book", action: "view" }];
    await expect(
      requireCapabilityFor(CTX("admin"), USER, "price_book", "view"),
    ).resolves.toBeUndefined();
    for (const action of ["create", "edit", "delete"] as const) {
      await expect(
        requireCapabilityFor(CTX("admin"), USER, "price_book", action),
      ).rejects.toThrowError(/NEXT_REDIRECT/);
    }
  });

  it("an admin with price_book:create can create but not edit or delete", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "price_book", action: "create" }];
    await expect(
      requireCapabilityFor(CTX("admin"), USER, "price_book", "create"),
    ).resolves.toBeUndefined();
    for (const action of ["edit", "delete"] as const) {
      await expect(
        requireCapabilityFor(CTX("admin"), USER, "price_book", action),
      ).rejects.toThrowError(/NEXT_REDIRECT/);
    }
  });

  it("an admin with price_book:manage can view, create, edit and delete", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "price_book", action: "manage" }];
    for (const action of ["view", "create", "edit", "delete"] as const) {
      await expect(
        requireCapabilityFor(CTX("admin"), USER, "price_book", action),
      ).resolves.toBeUndefined();
    }
  });

  it("the owner can do everything without any stored grant", async () => {
    mockRole = "owner";
    mockGrants = [];
    for (const action of ["view", "create", "edit", "delete"] as const) {
      await expect(
        requireCapabilityFor(CTX("owner"), USER, "price_book", action),
      ).resolves.toBeUndefined();
    }
  });

  it("staff are denied the price book entirely, even with a stray grant", async () => {
    mockRole = "staff";
    mockGrants = [{ module: "price_book", action: "manage" }];
    for (const action of ["view", "create", "edit", "delete"] as const) {
      await expect(
        requireCapabilityFor(CTX("staff"), USER, "price_book", action),
      ).rejects.toThrowError(/NEXT_REDIRECT/);
    }
  });
});
