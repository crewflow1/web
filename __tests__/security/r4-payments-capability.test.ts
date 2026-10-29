import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Role & Permissions R4 — payments module capability enforcement.
 *
 * Payments is server-action-based (no API routes). The segment layout gates the
 * pages (`payments:view`); each server action re-checks its capability via
 * requireCapabilityFor (owner short-circuits; admin needs the grant; staff
 * denied). Mixed mapping: the payment actions use `payments:*`, while voiding an
 * invoice (co-located) is an `invoices:edit` operation. Positive + negative.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ── A. source contracts ──────────────────────────────────────────────────────
describe("payments surfaces are capability-gated with the right action", () => {
  it("the layout requires payments:view, no residual management gate", () => {
    const code = codeOf(read("app/(app)/payments/layout.tsx"));
    expect(code).toMatch(/requireCapability\(\s*"payments",\s*"view"\s*\)/);
    expect(code).not.toMatch(/requireManagement(Api|Context|Role)/);
  });

  const FILES: Array<{ file: string; needs: Array<[string, string]> }> = [
    { file: "app/(app)/payments/actions.ts", needs: [["payments", "create"], ["payments", "edit"]] },
    { file: "app/(app)/payments/allocate-actions.ts", needs: [["payments", "create"]] },
    { file: "app/(app)/invoices/[id]/payment-actions.ts", needs: [["payments", "create"], ["payments", "delete"], ["invoices", "edit"]] },
    { file: "app/(app)/invoices/[id]/proof-actions.ts", needs: [["payments", "view"]] },
  ];
  for (const { file, needs } of FILES) {
    it(`${file} re-checks each capability via requireCapabilityFor, no residual management gate`, () => {
      const code = codeOf(read(file));
      expect(code, "no requireManagementRole left").not.toMatch(/requireManagementRole/);
      for (const [mod, action] of needs) {
        expect(code, `must gate ${mod}:${action}`).toMatch(
          new RegExp(`requireCapabilityFor\\([^)]*"${mod}",\\s*"${action}"\\s*\\)`),
        );
      }
    });
  }
});

// ── B. behavioural — requireCapabilityFor (the server-action helper) ─────────
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
  ({ membership: { org_id: "org-1", role }, org: { id: "org-1" } }) as never;
const USER = { id: "user-1" } as never;

beforeEach(() => {
  mockRole = "owner";
  mockGrants = [];
});

describe("requireCapabilityFor — owner full, admin granted-only, deny-default", () => {
  it("OWNER passes with no grants (unrestricted)", async () => {
    mockRole = "owner";
    await expect(requireCapabilityFor(CTX("owner"), USER, "payments", "delete")).resolves.toBeUndefined();
  });
  it("ADMIN with payments:create passes create but is DENIED delete", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "payments", action: "create" }];
    await expect(requireCapabilityFor(CTX("admin"), USER, "payments", "create")).resolves.toBeUndefined();
    await expect(requireCapabilityFor(CTX("admin"), USER, "payments", "delete")).rejects.toThrowError(/NEXT_REDIRECT/);
  });
  it("ADMIN with NO grant is denied (default-deny → redirect)", async () => {
    mockRole = "admin";
    mockGrants = [];
    await expect(requireCapabilityFor(CTX("admin"), USER, "payments", "view")).rejects.toThrowError(
      /NEXT_REDIRECT:\/dashboard\?error=forbidden/,
    );
  });
  it("STAFF is denied even with a stray grant row", async () => {
    mockRole = "staff";
    mockGrants = [{ module: "payments", action: "view" }];
    await expect(requireCapabilityFor(CTX("staff"), USER, "payments", "view")).rejects.toThrowError(/NEXT_REDIRECT/);
  });
});
