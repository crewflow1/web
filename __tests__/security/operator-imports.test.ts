import { beforeEach, describe, expect, it, vi } from "vitest";
import { entityFieldNames } from "@/lib/imports/detect";

/**
 * Operator Migration OS read + WRITE layer — authorisation + tenant-isolation.
 *
 * The admin client bypasses RLS, so isolation is enforced ONLY by this module:
 * (1) requireHqPage() gates every call; (2) every query is pinned to the
 * caller-supplied targetOrgId. These tests prove a non-operator does nothing and
 * that every operator read AND write is org-pinned (never cross-org). The remap
 * write is staging-only (import_rows), reversible, and status-gated to "detected".
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
  getOperatorImportEntities,
  operatorRemapColumns,
} from "@/lib/admin/operator-imports";

const VALID_IMPORT_ID = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

// Recorder + fixtures.
let eqCalls: Array<[string, unknown]> = [];
let rangeData: unknown[] = []; // fetchAllRows terminal (.range)
let singleData: unknown = null; // .maybeSingle terminal

type Chain = {
  select: () => Chain;
  update: () => Chain;
  order: () => Chain;
  in: () => Chain;
  eq: (k: string, v: unknown) => Chain;
  range: () => Promise<{ data: unknown; error: null }>;
  maybeSingle: () => Promise<{ data: unknown; error: null }>;
  then: (resolve: (r: { data: unknown; error: null }) => unknown) => unknown;
};

function fakeClient() {
  return {
    from(_table: string): Chain {
      const chain: Chain = {
        select: () => chain,
        update: () => chain,
        order: () => chain,
        in: () => chain,
        eq: (k, v) => {
          eqCalls.push([k, v]);
          return chain;
        },
        range: async () => ({ data: rangeData, error: null }),
        maybeSingle: async () => ({ data: singleData, error: null }),
        // Awaiting the builder directly (the update write path) resolves here.
        then: (resolve) => resolve({ data: null, error: null }),
      };
      return chain;
    },
  };
}

beforeEach(() => {
  eqCalls = [];
  rangeData = [];
  singleData = null;
  requireHqPageMock.mockReset().mockResolvedValue({ email: "op@crewflow.uk" });
  createAdminClientMock.mockReset().mockImplementation(fakeClient);
});

describe("operator read layer — authorisation", () => {
  it("a non-operator (requireHqPage 404s) does nothing and never touches the admin client", async () => {
    requireHqPageMock.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(listOperatorOrgs()).rejects.toThrow();
    await expect(listOperatorImports("org-A")).rejects.toThrow();
    await expect(getOperatorImport("org-A", VALID_IMPORT_ID)).rejects.toThrow();
    await expect(getOperatorImportEntities("org-A", VALID_IMPORT_ID)).rejects.toThrow();
    await expect(
      operatorRemapColumns({ targetOrgId: "org-A", importId: VALID_IMPORT_ID, entity: "customer", overrides: { name: "Name" } }),
    ).rejects.toThrow();
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });
});

describe("operator read layer — org isolation", () => {
  it("lists a target org's imports pinned to that org id", async () => {
    rangeData = [{ id: "imp-1", name: "Sage", status: "uploaded", created_at: "2026-10-01T10:00:00Z", committed_at: null, rolled_back_at: null, created_by: null }];
    const rows = await listOperatorImports("org-A");
    expect(rows).toHaveLength(1);
    expect(eqCalls).toContainEqual(["org_id", "org-A"]);
  });

  it("detail read is pinned to BOTH org id and row id", async () => {
    singleData = { id: "imp-1", name: "x", status: "uploaded", created_at: "2026-10-01T10:00:00Z", committed_at: null, rolled_back_at: null, created_by: null };
    const im = await getOperatorImport("org-A", VALID_IMPORT_ID);
    expect(im?.id).toBe("imp-1");
    expect(eqCalls).toContainEqual(["org_id", "org-A"]);
    expect(eqCalls).toContainEqual(["id", VALID_IMPORT_ID]);
  });

  it("detail returns null when the row is not in the target org", async () => {
    singleData = null;
    expect(await getOperatorImport("org-A", VALID_IMPORT_ID)).toBeNull();
    expect(eqCalls).toContainEqual(["org_id", "org-A"]);
  });

  it("entity introspection is org-pinned and groups open rows + headers", async () => {
    rangeData = [
      { entity_type: "customer", raw: { Name: "a", Email: "b" }, status: "pending" },
      { entity_type: "customer", raw: { Name: "c" }, status: "needs_review" },
    ];
    const ents = await getOperatorImportEntities("org-A", VALID_IMPORT_ID);
    expect(ents).toEqual([{ entity: "customer", openRows: 2, headers: ["Email", "Name"] }]);
    expect(eqCalls).toContainEqual(["org_id", "org-A"]);
  });

  it("empty ids read nothing (no unpinned query)", async () => {
    expect(await listOperatorImports("")).toEqual([]);
    expect(await getOperatorImport("", VALID_IMPORT_ID)).toBeNull();
    expect(await getOperatorImportEntities("org-A", "")).toEqual([]);
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });
});

describe("operator WRITE — column remap (staging-only, org-isolated)", () => {
  const field = entityFieldNames("customer")[0]!; // a real canonical field

  it("remaps open rows of one entity, pinned to the target org on every read + write", async () => {
    singleData = { id: VALID_IMPORT_ID, status: "detected" };
    rangeData = [{ id: "row-1", raw: { Hdr: "value" } }];
    const res = await operatorRemapColumns({
      targetOrgId: "org-A",
      importId: VALID_IMPORT_ID,
      entity: "customer",
      overrides: { [field]: "Hdr" },
    });
    expect(res).toEqual({ ok: true, changed: 1 });
    // org pin appears on the guard read, the rows read, AND the update — never another org.
    const orgPins = eqCalls.filter(([k]) => k === "org_id");
    expect(orgPins.length).toBeGreaterThanOrEqual(3);
    expect(orgPins.every(([, v]) => v === "org-A")).toBe(true);
  });

  it("refuses when the import is not in the reviewable (detected) state", async () => {
    singleData = { id: VALID_IMPORT_ID, status: "committed" };
    expect(
      await operatorRemapColumns({ targetOrgId: "org-A", importId: VALID_IMPORT_ID, entity: "customer", overrides: { [field]: "Hdr" } }),
    ).toEqual({ ok: false, error: "not_reviewable" });
  });

  it("refuses when the import does not belong to the target org (not_found)", async () => {
    singleData = null; // org pin filtered it out
    expect(
      await operatorRemapColumns({ targetOrgId: "org-A", importId: VALID_IMPORT_ID, entity: "customer", overrides: { [field]: "Hdr" } }),
    ).toEqual({ ok: false, error: "not_found" });
    expect(eqCalls).toContainEqual(["org_id", "org-A"]);
  });

  it("rejects a non-remappable entity before any query", async () => {
    expect(
      await operatorRemapColumns({ targetOrgId: "org-A", importId: VALID_IMPORT_ID, entity: "bogus", overrides: { x: "y" } }),
    ).toEqual({ ok: false, error: "pick_entity_type" });
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it("drops overrides that are not canonical fields and refuses when none remain", async () => {
    expect(
      await operatorRemapColumns({ targetOrgId: "org-A", importId: VALID_IMPORT_ID, entity: "customer", overrides: { not_a_real_field: "Hdr" } }),
    ).toEqual({ ok: false, error: "pick_column" });
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed import id before any query", async () => {
    expect(
      await operatorRemapColumns({ targetOrgId: "org-A", importId: "not-a-uuid", entity: "customer", overrides: { [field]: "Hdr" } }),
    ).toEqual({ ok: false, error: "bad_id" });
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });
});
