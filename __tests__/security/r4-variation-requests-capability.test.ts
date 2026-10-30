import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Role & Permissions R4 — variation requests.
 *
 * A variation request is a customer-asked change to a job. Two distinct steps:
 *   createVariationRequest  → MEMBER-OPEN (staff field intake, like cost-entry) —
 *                             deliberately NOT capability-gated.
 *   reviewVariationRequest  → quotes:approve (the commercial decision on whether
 *                             the change proceeds to a variation order).
 *
 * This pins the split so a refactor can neither (a) lock staff out of logging a
 * request, nor (b) let a non-approver accept/reject one.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const SRC = "app/(app)/jobs/[id]/variation-request-actions.ts";

const sliceFn = (code: string, name: string): string => {
  const start = code.indexOf(`export async function ${name}`);
  expect(start, `${name} present`).toBeGreaterThanOrEqual(0);
  const next = code.indexOf("export async function ", start + 1);
  return code.slice(start, next === -1 ? undefined : next);
};

describe("variation-request intake vs review split", () => {
  const code = codeOf(read(SRC));

  it("reviewVariationRequest gates quotes:approve", () => {
    const body = sliceFn(code, "reviewVariationRequest");
    expect(body).toMatch(
      /requireCapabilityFor\(\s*ctx,\s*user,\s*"quotes",\s*"approve"\s*\)/,
    );
  });

  it("createVariationRequest stays MEMBER-OPEN (no capability / management gate)", () => {
    const body = sliceFn(code, "createVariationRequest");
    expect(body).not.toMatch(/requireCapabilityFor/);
    expect(body).not.toMatch(/requireManagementRole/);
    expect(body).not.toMatch(/hasCapability/);
    // It still resolves org context (for the active-org job pin) — that's the
    // member floor, not an elevation.
    expect(body).toMatch(/requireOrgContext\(\)/);
  });

  it("no residual coarse management gate remains in the file", () => {
    expect(code).not.toMatch(/requireManagementRole/);
  });
});

// Behavioural — quotes:approve semantics gate review; non-approvers refused.
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

describe("reviewVariationRequest requires quotes:approve", () => {
  it("owner can review without a stored grant", async () => {
    mockRole = "owner";
    await expect(
      requireCapabilityFor(CTX("owner"), USER, "quotes", "approve"),
    ).resolves.toBeUndefined();
  });

  it("an admin with quotes:approve can review", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "quotes", action: "approve" }];
    await expect(
      requireCapabilityFor(CTX("admin"), USER, "quotes", "approve"),
    ).resolves.toBeUndefined();
  });

  it("an admin with only quotes:edit (not approve) is denied review", async () => {
    mockRole = "admin";
    mockGrants = [{ module: "quotes", action: "edit" }];
    await expect(
      requireCapabilityFor(CTX("admin"), USER, "quotes", "approve"),
    ).rejects.toThrowError(/NEXT_REDIRECT/);
  });

  it("staff cannot review even with a stray grant", async () => {
    mockRole = "staff";
    mockGrants = [{ module: "quotes", action: "approve" }];
    await expect(
      requireCapabilityFor(CTX("staff"), USER, "quotes", "approve"),
    ).rejects.toThrowError(/NEXT_REDIRECT/);
  });
});
