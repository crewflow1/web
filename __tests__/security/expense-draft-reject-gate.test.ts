import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * P2 audit M-3 — expense_drafts reject gate.
 *
 * The `expense_drafts` UPDATE RLS policy is admin-only
 * (`is_org_admin(org_id)`, migration 20260623000000). But rejectExpenseDraft
 * writes `status='rejected'` via the SERVICE-ROLE admin client, which BYPASSES
 * RLS — so before the fix ANY authenticated member could reject a draft the
 * org reserves for admin review, and the write was issued with no check that
 * the draft was still pending (an already-approved draft could be flipped to
 * `rejected`, orphaning its posted `finances` row).
 *
 * The fix mirrors approveExpenseDraft: an in-code owner/admin gate, plus an
 * org-scoped status precheck on the RLS client before the admin-client write.
 *
 * Behavioural tests mock every dependency; redirect() throws (as in Next) so
 * each path ends in a captured redirect URL. Source-contract tests pin the
 * gate ordering so a refactor can't silently drop it.
 */

// --- module mocks (hoisted above imports by vitest) ---
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
  // Faithful mirror of the fix-1 management guard the action now ALSO calls
  // (defense-in-depth over its own internal role gate): staff redirect exactly
  // like production, owners/admins pass through.
  requireManagementRole: (ctx?: { membership?: { role?: string } }) => {
    const role = ctx?.membership?.role;
    if (role !== "owner" && role !== "admin") {
      redirectMock("/dashboard?error=forbidden");
    }
  },
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

import { rejectExpenseDraft } from "@/app/(app)/expenses/actions";

const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "99999999-9999-9999-9999-999999999999";
const DRAFT = "33333333-3333-3333-3333-333333333333";
const FIN = "44444444-4444-4444-4444-444444444444";

// Records what the admin-client UPDATE was given (or whether it ran at all).
const adminUpdateSpy = vi.fn();
let adminEqs: Record<string, unknown> = {};

function tenantClientReturning(
  draft: { id: string; status: string | null; finance_id: string | null } | null,
) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: draft }),
  };
  return { from: () => builder };
}

function adminClient() {
  const builder: Record<string, unknown> = {
    update: (row: unknown) => {
      adminUpdateSpy(row);
      return builder;
    },
    eq: (k: string, v: unknown) => {
      adminEqs[k] = v;
      return builder;
    },
    then: (resolve: (v: { error: null }) => unknown) =>
      Promise.resolve({ error: null }).then(resolve),
  };
  return { from: () => builder };
}

function ctxWithRole(role: string) {
  return {
    ctx: { org: { id: ORG }, membership: { role } },
    user: { id: USER, email: "u@test" },
  };
}

function rejectForm(): FormData {
  const fd = new FormData();
  fd.set("draft_id", DRAFT);
  fd.set("reason", "duplicate receipt");
  return fd;
}

/** Run the action and return the redirect URL it threw with. */
async function runReject(): Promise<string> {
  try {
    await rejectExpenseDraft(rejectForm());
  } catch {
    /* redirect() throws by design */
  }
  const call = redirectMock.mock.calls.at(-1);
  return call ? String(call[0]) : "";
}

beforeEach(() => {
  vi.clearAllMocks();
  adminEqs = {};
});

describe("M-3 — rejectExpenseDraft enforces the admin-only gate", () => {
  it("forbids a non-admin member — no read, no write, no audit", async () => {
    requireOrgContextMock.mockResolvedValue(ctxWithRole("member"));

    const url = await runReject();

    expect(url).toContain("error=forbidden");
    // Bailed at the role gate, before touching either Supabase client.
    expect(createClientMock).not.toHaveBeenCalled();
    expect(createAdminClientMock).not.toHaveBeenCalled();
    expect(adminUpdateSpy).not.toHaveBeenCalled();
    expect(recordAdminActivityMock).not.toHaveBeenCalled();
  });

  it("lets an admin reject a pending draft — org-scoped write + audit", async () => {
    requireOrgContextMock.mockResolvedValue(ctxWithRole("admin"));
    createClientMock.mockResolvedValue(
      tenantClientReturning({ id: DRAFT, status: "extracted", finance_id: null }),
    );
    createAdminClientMock.mockReturnValue(adminClient());

    const url = await runReject();

    expect(url).toContain("saved=rejected");
    expect(adminUpdateSpy).toHaveBeenCalledTimes(1);
    expect(adminUpdateSpy.mock.calls[0]?.[0]).toMatchObject({ status: "rejected" });
    // Write is org-scoped (service-role bypasses RLS).
    expect(adminEqs.id).toBe(DRAFT);
    expect(adminEqs.org_id).toBe(ORG);
    expect(recordAdminActivityMock).toHaveBeenCalledTimes(1);
  });

  it("lets an owner reject a pending draft", async () => {
    requireOrgContextMock.mockResolvedValue(ctxWithRole("owner"));
    createClientMock.mockResolvedValue(
      tenantClientReturning({ id: DRAFT, status: "extracted", finance_id: null }),
    );
    createAdminClientMock.mockReturnValue(adminClient());

    const url = await runReject();

    expect(url).toContain("saved=rejected");
    expect(adminUpdateSpy).toHaveBeenCalledTimes(1);
  });

  it("refuses to reject an already-approved draft (no orphaned finances row)", async () => {
    requireOrgContextMock.mockResolvedValue(ctxWithRole("admin"));
    createClientMock.mockResolvedValue(
      tenantClientReturning({ id: DRAFT, status: "approved", finance_id: FIN }),
    );
    createAdminClientMock.mockReturnValue(adminClient());

    const url = await runReject();

    expect(url).toContain("error=already_approved");
    expect(adminUpdateSpy).not.toHaveBeenCalled();
    expect(recordAdminActivityMock).not.toHaveBeenCalled();
  });

  it("returns not_found for a foreign / nonexistent draft id — no write", async () => {
    requireOrgContextMock.mockResolvedValue(ctxWithRole("admin"));
    createClientMock.mockResolvedValue(tenantClientReturning(null));
    createAdminClientMock.mockReturnValue(adminClient());

    const url = await runReject();

    expect(url).toContain("error=not_found");
    expect(adminUpdateSpy).not.toHaveBeenCalled();
  });
});

// =====================================================================
// Source contract — the gate must stay before the write
// =====================================================================

const ROOT = resolve(__dirname, "..", "..");
const actionSrc = readFileSync(
  resolve(ROOT, "app/(app)/expenses/actions.ts"),
  "utf8",
);
const pageSrc = readFileSync(
  resolve(ROOT, "app/(app)/expenses/[id]/page.tsx"),
  "utf8",
);

const start = actionSrc.indexOf("export async function rejectExpenseDraft");
const end = actionSrc.indexOf("function mimeToExt", start);
const rejectFn = actionSrc.slice(start, end === -1 ? undefined : end);

describe("M-3 contract — reject gate is pinned in source", () => {
  it("checks owner/admin role inside rejectExpenseDraft", () => {
    expect(rejectFn).toMatch(/ctx\.membership\.role\s*!==\s*["']owner["']/);
    expect(rejectFn).toMatch(/ctx\.membership\.role\s*!==\s*["']admin["']/);
  });

  it("performs the role check BEFORE the admin-client update", () => {
    const guardIdx = rejectFn.indexOf("membership.role");
    const updateIdx = rejectFn.indexOf(".update(");
    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThanOrEqual(0);
    expect(guardIdx).toBeLessThan(updateIdx);
  });

  it("org-scopes both the status precheck and the write (>=2 org_id filters)", () => {
    expect(rejectFn).toMatch(/\.select\(\s*["']id, status, finance_id["']\s*\)/);
    expect(rejectFn).toMatch(/\.maybeSingle\(\)/);
    const orgFilters = (
      rejectFn.match(/\.eq\(\s*["']org_id["']\s*,\s*ctx\.org\.id\s*\)/g) ?? []
    ).length;
    expect(orgFilters).toBeGreaterThanOrEqual(2);
  });

  it("refuses an already-approved / finance-stamped draft", () => {
    expect(rejectFn).toMatch(/status === ["']approved["']/);
    expect(rejectFn).toMatch(/finance_id/);
  });

  it("redirects forbidden, and the page renders a message for it", () => {
    expect(rejectFn).toMatch(/error=forbidden/);
    expect(pageSrc).toMatch(/forbidden:/);
  });
});
