import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Operator Migration OS read layer — authorisation + tenant-isolation.
 *
 * The admin client bypasses RLS, so isolation is enforced ONLY by this module:
 * (1) requireHqPage() gates every call; (2) every query is pinned to the
 * caller-supplied targetOrgId. These tests prove a non-operator reads nothing
 * and that an operator's reads are always org-pinned (never cross-org).
 */

const { requireHqPageMock, createAdminClientMock } = vi.hoisted(() => ({
  requireHqPageMock: vi.fn(),
  createAdminClientMock: vi.fn(),
}));
vi.mock("@/server/auth/hq", () => ({ requireHqPage: requireHqPageMock }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: createAdminClientMock }));

import {
  listOperatorOrgs,
  listOperatorImports,
  getOperatorImport,
} from "@/lib/admin/operator-imports";

// Mutable fixtures + the recorder for the .eq() pins applied on the last query.
let eqCalls: Array<[string, unknown]> = [];
let orgRows: Array<{ id: string; name: string }> = [];
let importRows: unknown[] = [];
let detailRow: unknown = null;

function fakeClient() {
  return {
    from(table: string) {
      const chain = {
        select: () => chain,
        order: () => chain,
        limit: async () => ({
          data: table === "organizations" ? orgRows : importRows,
          error: null,
        }),
        eq: (k: string, v: unknown) => {
          eqCalls.push([k, v]);
          return chain;
        },
        maybeSingle: async () => ({ data: detailRow, error: null }),
      };
      return chain;
    },
  };
}

beforeEach(() => {
  eqCalls = [];
  orgRows = [{ id: "org-A", name: "Alpha Ltd" }];
  importRows = [
    {
      id: "imp-1",
      name: "Sage export",
      status: "uploaded",
      created_at: "2026-10-01T10:00:00Z",
      committed_at: null,
      rolled_back_at: null,
      created_by: null,
    },
  ];
  detailRow = null;
  requireHqPageMock.mockReset().mockResolvedValue({ email: "op@crewflow.uk" });
  createAdminClientMock.mockReset().mockImplementation(fakeClient);
});

describe("operator Migration OS read layer — authorisation", () => {
  it("a non-operator (requireHqPage 404s) reads nothing and never touches the admin client", async () => {
    requireHqPageMock.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(listOperatorOrgs()).rejects.toThrow();
    await expect(listOperatorImports("org-A")).rejects.toThrow();
    await expect(getOperatorImport("org-A", "imp-1")).rejects.toThrow();
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });
});

describe("operator Migration OS read layer — org isolation", () => {
  it("lists a target org's imports pinned to that org id", async () => {
    const rows = await listOperatorImports("org-A");
    expect(rows).toHaveLength(1);
    expect(eqCalls).toContainEqual(["org_id", "org-A"]);
  });

  it("detail read is pinned to BOTH org id and row id (no cross-org reach)", async () => {
    detailRow = {
      id: "imp-1",
      name: "x",
      status: "uploaded",
      created_at: "2026-10-01T10:00:00Z",
      committed_at: null,
      rolled_back_at: null,
      created_by: null,
    };
    const im = await getOperatorImport("org-A", "imp-1");
    expect(im?.id).toBe("imp-1");
    expect(eqCalls).toContainEqual(["org_id", "org-A"]);
    expect(eqCalls).toContainEqual(["id", "imp-1"]);
  });

  it("returns null when the row does not belong to the target org", async () => {
    detailRow = null; // the org pin filtered org B's row out
    expect(await getOperatorImport("org-A", "imp-from-B")).toBeNull();
    expect(eqCalls).toContainEqual(["org_id", "org-A"]);
  });

  it("an empty target org id reads nothing (no unpinned query)", async () => {
    expect(await listOperatorImports("")).toEqual([]);
    expect(await getOperatorImport("", "imp-1")).toBeNull();
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });
});
