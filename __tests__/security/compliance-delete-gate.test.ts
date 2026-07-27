import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * P2 audit M-4 — compliance_documents delete gate (admin + count-check).
 *
 * compliance_documents DELETE is admin-only RLS (`is_org_admin(org_id)`,
 * migration 20260623000000). deleteComplianceDocument deletes the row on the
 * RLS-scoped tenant client (so the DB delete is gated), BUT it then removes the
 * storage object on the SERVICE-ROLE admin client (RLS bypassed) guarded only
 * by `if (row?.storage_path)`. Before the fix, a plain member could SELECT the
 * row (member-scoped SELECT policy), have their DB delete RLS-no-op (0 rows,
 * `error: null`), and STILL reach admin.storage.remove() — wiping the file and
 * orphaning the row, while the page reported `saved=deleted`.
 *
 * The fix adds an in-code owner/admin gate and ties the storage removal +
 * success to an exact delete count (count > 0), so a no-op delete can never
 * orphan a file.
 *
 * redirect() throws (as in Next), so each path ends in a captured URL.
 */

const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (p: string) => revalidatePathMock(p),
}));

const requireOrgContextMock = vi.fn();
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: () => requireOrgContextMock(),
}));

const recordAdminActivityMock = vi.fn();
vi.mock("@/server/services/hq-audit", () => ({
  recordAdminActivity: (a: unknown) => recordAdminActivityMock(a),
}));

const createClientMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => createClientMock(),
}));

const createAdminClientMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClientMock(),
}));

import { deleteComplianceDocument } from "@/app/(app)/compliance/actions";

const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "99999999-9999-9999-9999-999999999999";
const DOC = "33333333-3333-3333-3333-333333333333";

// Records the storage object the admin client was asked to delete.
const removeSpy = vi.fn();

function tenantClientReturning(opts: {
  row: { storage_path: string | null; title: string | null } | null;
  count: number | null;
  error?: { message: string } | null;
}) {
  const from = () => {
    const builder: Record<string, unknown> = {
      select: () => builder,
      delete: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({ data: opts.row }),
      then: (
        resolve: (v: { error: { message: string } | null; count: number | null }) => unknown,
        reject?: (e: unknown) => unknown,
      ) =>
        Promise.resolve({ error: opts.error ?? null, count: opts.count }).then(
          resolve,
          reject,
        ),
    };
    return builder;
  };
  return { from };
}

function adminClient() {
  return {
    storage: {
      from: () => ({
        remove: (paths: string[]) => {
          removeSpy(paths);
          return Promise.resolve({ data: null, error: null });
        },
      }),
    },
  };
}

function ctxWithRole(role: string) {
  return {
    ctx: { org: { id: ORG }, membership: { role } },
    user: { id: USER, email: "u@test" },
  };
}

async function runDelete(): Promise<string> {
  try {
    await deleteComplianceDocument(DOC);
  } catch {
    /* redirect() throws by design */
  }
  const call = redirectMock.mock.calls.at(-1);
  return call ? String(call[0]) : "";
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("M-4 — deleteComplianceDocument enforces admin + count gate", () => {
  it("forbids a non-admin member — no read, no delete, no blob removal, no audit", async () => {
    requireOrgContextMock.mockResolvedValue(ctxWithRole("member"));

    const url = await runDelete();

    expect(url).toContain("error=forbidden");
    expect(createClientMock).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(recordAdminActivityMock).not.toHaveBeenCalled();
  });

  it("lets an admin delete an own-org doc — removes the correct blob + audits", async () => {
    requireOrgContextMock.mockResolvedValue(ctxWithRole("admin"));
    createClientMock.mockResolvedValue(
      tenantClientReturning({
        row: { storage_path: `${ORG}/abc.pdf`, title: "Insurance" },
        count: 1,
      }),
    );
    createAdminClientMock.mockReturnValue(adminClient());

    const url = await runDelete();

    expect(url).toContain("saved=deleted");
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy.mock.calls[0]?.[0]).toEqual([`${ORG}/abc.pdf`]);
    expect(recordAdminActivityMock).toHaveBeenCalledTimes(1);
  });

  it("lets an owner delete", async () => {
    requireOrgContextMock.mockResolvedValue(ctxWithRole("owner"));
    createClientMock.mockResolvedValue(
      tenantClientReturning({
        row: { storage_path: `${ORG}/abc.pdf`, title: "Insurance" },
        count: 1,
      }),
    );
    createAdminClientMock.mockReturnValue(adminClient());

    const url = await runDelete();

    expect(url).toContain("saved=deleted");
    expect(removeSpy).toHaveBeenCalledTimes(1);
  });

  it("count=0 (foreign / already gone) → not_found, never touches storage", async () => {
    requireOrgContextMock.mockResolvedValue(ctxWithRole("admin"));
    createClientMock.mockResolvedValue(
      tenantClientReturning({ row: null, count: 0 }),
    );
    createAdminClientMock.mockReturnValue(adminClient());

    const url = await runDelete();

    expect(url).toContain("error=not_found");
    expect(removeSpy).not.toHaveBeenCalled();
    expect(recordAdminActivityMock).not.toHaveBeenCalled();
  });

  it("count gate: even with a readable row, a 0-row delete removes NO blob", async () => {
    // Models the pre-fix orphan path: row readable, but the delete affected
    // nothing. The count gate must stop the storage removal.
    requireOrgContextMock.mockResolvedValue(ctxWithRole("admin"));
    createClientMock.mockResolvedValue(
      tenantClientReturning({
        row: { storage_path: `${ORG}/abc.pdf`, title: "Insurance" },
        count: 0,
      }),
    );
    createAdminClientMock.mockReturnValue(adminClient());

    const url = await runDelete();

    expect(url).toContain("error=not_found");
    expect(removeSpy).not.toHaveBeenCalled();
  });
});

// =====================================================================
// Source contract
// =====================================================================

const ROOT = resolve(__dirname, "..", "..");
const actionSrc = readFileSync(
  resolve(ROOT, "app/(app)/compliance/actions.ts"),
  "utf8",
);
const pageSrc = readFileSync(
  resolve(ROOT, "app/(app)/compliance/page.tsx"),
  "utf8",
);

const start = actionSrc.indexOf("export async function deleteComplianceDocument");
const end = actionSrc.indexOf(
  "export async function getComplianceDocSignedUrl",
  start,
);
const deleteFn = actionSrc.slice(start, end === -1 ? undefined : end);

describe("M-4 contract — admin + count gate pinned in source", () => {
  it("checks owner/admin role before the delete", () => {
    expect(deleteFn).toMatch(/ctx\.membership\.role\s*!==\s*["']owner["']/);
    expect(deleteFn).toMatch(/ctx\.membership\.role\s*!==\s*["']admin["']/);
    const guardIdx = deleteFn.indexOf("membership.role");
    const delIdx = deleteFn.indexOf(".delete(");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeLessThan(delIdx);
  });

  it("deletes with an exact count and guards on it", () => {
    expect(deleteFn).toMatch(/\.delete\(\s*\{\s*count:\s*["']exact["']\s*\}\s*\)/);
    expect(deleteFn).toMatch(/if\s*\(\s*!count\s*\)/);
  });

  it("ties the storage removal to the count gate (removal comes after the !count guard)", () => {
    const countGuardIdx = deleteFn.indexOf("!count");
    // `.remove([` (with the array arg) matches the real storage call, not the
    // `.remove()` mention in the SECURITY comment above it.
    const removeIdx = deleteFn.indexOf(".remove([");
    expect(countGuardIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(countGuardIdx).toBeLessThan(removeIdx);
  });

  it("org-scopes both the read and the delete (>=2 org_id filters)", () => {
    const orgFilters = (
      deleteFn.match(/\.eq\(\s*["']org_id["']\s*,\s*ctx\.org\.id\s*\)/g) ?? []
    ).length;
    expect(orgFilters).toBeGreaterThanOrEqual(2);
  });

  it("page renders messages for the new failure modes", () => {
    expect(pageSrc).toMatch(/forbidden:/);
    expect(pageSrc).toMatch(/not_found:/);
  });
});
