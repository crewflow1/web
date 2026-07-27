import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/**
 * P2 audit M-5 — tenant_attachments DELETE restricted to owner/admin.
 *
 * tenant_attachments holds polymorphic file attachments for tenant entities
 * (customers, jobs, quotes, invoices, suppliers, memberships, leads). The
 * original RLS (migration 20260623000000) granted DELETE to ANY org member:
 *
 *   for delete using (org_id in (select public.current_org_ids()))
 *
 * so a low-privilege staff/member could permanently destroy any file attached
 * to any record in their org — including financial docs on quotes/invoices.
 * deleteTenantAttachment compounded it: the storage object is removed with the
 * SERVICE-ROLE admin client, and the row delete returned data=null/error=null
 * when RLS removed zero rows, yet the function still recorded an audit entry
 * and returned { ok: true } — a false success.
 *
 * The fix:
 *   1. migration 20260705000000 tightens DELETE to public.is_org_admin(org_id)
 *      (owner/admin only); SELECT + INSERT stay member-level (unchanged).
 *   2. deleteTenantAttachment re-checks the role in code (deterministic
 *      forbidden + defense-in-depth) and ties success to a row actually being
 *      deleted (no false success / no audit on a no-op).
 *   3. the UI only shows the Delete control to owner/admin.
 */

// ---------------------------------------------------------------------------
// Behavioural — deleteTenantAttachment role + affected-row gating
// ---------------------------------------------------------------------------

const requireOrgContextMock = vi.fn();
vi.mock("@/server/auth/session", () => ({
  requireOrgContext: () => requireOrgContextMock(),
}));

const createClientMock = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => createClientMock(),
}));

const createAdminClientMock = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClientMock(),
}));

const recordAdminActivitySpy = vi.fn();
vi.mock("@/server/services/hq-audit", () => ({
  recordAdminActivity: (input: unknown) => recordAdminActivitySpy(input),
}));

import { deleteTenantAttachment } from "@/server/services/tenant-attachments";

const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "99999999-9999-9999-9999-999999999999";
const ATTACH = "33333333-3333-3333-3333-333333333333";
const STORAGE_PATH = `${ORG}/jobs/abcabcab-0000-0000-0000-000000000000/${ATTACH}.pdf`;

function ctxFor(role: string) {
  return {
    ctx: { org: { id: ORG }, membership: { org_id: ORG, role } },
    user: { id: USER, email: "u@test" },
  };
}

// Tenant client whose .delete().eq().select().maybeSingle() resolves to result.
const deleteSpy = vi.fn();
function tenantReturning(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {
    delete: () => {
      deleteSpy();
      return builder;
    },
    eq: () => builder,
    select: () => builder,
    maybeSingle: async () => result,
  };
  return { from: () => builder };
}

// Admin (service-role) client — only storage.remove is exercised by delete.
// remove() must return a thenable (the code chains .catch on it).
const removeSpy = vi.fn((paths: string[]) =>
  Promise.resolve({ data: paths, error: null }),
);
function adminClient() {
  return {
    storage: { from: () => ({ remove: (paths: string[]) => removeSpy(paths) }) },
  };
}

describe("M-5 — deleteTenantAttachment enforces owner/admin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createAdminClientMock.mockReturnValue(adminClient());
  });

  it("member → forbidden; no row delete, no storage removal, no audit", async () => {
    requireOrgContextMock.mockResolvedValue(ctxFor("member"));
    // Even if RLS would have returned a row, the in-code gate bails first.
    createClientMock.mockResolvedValue(
      tenantReturning({ data: { storage_path: STORAGE_PATH }, error: null }),
    );

    const res = await deleteTenantAttachment(ATTACH);

    expect(res).toEqual({ ok: false, error: "forbidden" });
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(removeSpy).not.toHaveBeenCalled();
    expect(recordAdminActivitySpy).not.toHaveBeenCalled();
  });

  it("owner → deletes the row, removes the storage object, records audit", async () => {
    requireOrgContextMock.mockResolvedValue(ctxFor("owner"));
    createClientMock.mockResolvedValue(
      tenantReturning({ data: { storage_path: STORAGE_PATH }, error: null }),
    );

    const res = await deleteTenantAttachment(ATTACH);

    expect(res).toEqual({ ok: true, attachment_id: ATTACH });
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith([STORAGE_PATH]);
    expect(recordAdminActivitySpy).toHaveBeenCalledTimes(1);
    expect(recordAdminActivitySpy.mock.calls[0]?.[0]).toMatchObject({
      action: "tenant_attachment.delete",
      targetId: ATTACH,
    });
  });

  it("admin → delete allowed (same as owner)", async () => {
    requireOrgContextMock.mockResolvedValue(ctxFor("admin"));
    createClientMock.mockResolvedValue(
      tenantReturning({ data: { storage_path: STORAGE_PATH }, error: null }),
    );

    const res = await deleteTenantAttachment(ATTACH);

    expect(res).toEqual({ ok: true, attachment_id: ATTACH });
    expect(removeSpy).toHaveBeenCalledWith([STORAGE_PATH]);
    expect(recordAdminActivitySpy).toHaveBeenCalledTimes(1);
  });

  it("admin but RLS removed 0 rows (data null) → not_deleted, no storage removal, no audit", async () => {
    // Defense in depth: even past the in-code role gate, a no-op delete (e.g.
    // foreign id, already gone, or an RLS refusal) must NOT report success.
    requireOrgContextMock.mockResolvedValue(ctxFor("admin"));
    createClientMock.mockResolvedValue(tenantReturning({ data: null, error: null }));

    const res = await deleteTenantAttachment(ATTACH);

    expect(res).toEqual({ ok: false, error: "not_deleted" });
    expect(removeSpy).not.toHaveBeenCalled();
    expect(recordAdminActivitySpy).not.toHaveBeenCalled();
  });

  it("tenant delete error → surfaces the message, no storage removal, no audit", async () => {
    requireOrgContextMock.mockResolvedValue(ctxFor("admin"));
    createClientMock.mockResolvedValue(
      tenantReturning({ data: null, error: { message: "db boom" } }),
    );

    const res = await deleteTenantAttachment(ATTACH);

    expect(res).toEqual({ ok: false, error: "db boom" });
    expect(removeSpy).not.toHaveBeenCalled();
    expect(recordAdminActivitySpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Source contract — migration, service gate, and UI gate pinned in source
// (CI has no database, so RLS itself is asserted against migration text.)
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

// Strip SQL line comments (-- ... EOL) so negative assertions test the
// EXECUTABLE statements, not documentation that quotes the old policy.
const sqlOnly = (src: string) =>
  src
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("--");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

const NEW_MIG = "supabase/migrations/20260705000000_tenant_attachments_delete_admin_only.sql";
const ORIG_MIG = "supabase/migrations/20260623000000_final_additions.sql";

describe("M-5 migration — delete tightened to is_org_admin", () => {
  const mig = read(NEW_MIG);

  it("drops the old delete policy then recreates it (idempotent)", () => {
    expect(mig).toMatch(
      /drop policy if exists tenant_attachments_delete on public\.tenant_attachments/i,
    );
    expect(mig).toMatch(
      /create policy tenant_attachments_delete on public\.tenant_attachments/i,
    );
  });

  it("delete is gated on public.is_org_admin(org_id), not org membership", () => {
    expect(mig).toMatch(
      /for delete\s+using\s*\(\s*public\.is_org_admin\(org_id\)\s*\)/i,
    );
    // Executable SQL must not reference the broad member helper.
    expect(sqlOnly(mig)).not.toMatch(/current_org_ids/);
  });

  it("touches ONLY the delete policy (no select/insert/update changes)", () => {
    expect(mig).not.toMatch(/for select/i);
    expect(mig).not.toMatch(/for insert/i);
    expect(mig).not.toMatch(/for update/i);
    expect(mig).not.toMatch(/tenant_attachments_select/);
    expect(mig).not.toMatch(/tenant_attachments_insert/);
  });
});

describe("M-5 — no broad member delete policy remains (final replayed state)", () => {
  const MIG_DIR = resolve(ROOT, "supabase/migrations");
  const definers = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) =>
      /create policy\s+tenant_attachments_delete/i.test(
        readFileSync(resolve(MIG_DIR, f), "utf8"),
      ),
    )
    .sort();

  it("the LAST migration to (re)create the delete policy is the admin-only one", () => {
    // Migrations replay in filename order; whichever creates the policy last
    // wins. That must be the tightening migration, gated on is_org_admin.
    expect(definers.length).toBeGreaterThanOrEqual(2);
    const last = definers[definers.length - 1]!;
    expect(last).toBe("20260705000000_tenant_attachments_delete_admin_only.sql");
    const src = readFileSync(resolve(MIG_DIR, last), "utf8");
    expect(src).toMatch(/public\.is_org_admin\(org_id\)/);
    expect(sqlOnly(src)).not.toMatch(/current_org_ids/);
  });
});

describe("M-5 — SELECT/INSERT remain member-level (unchanged)", () => {
  const orig = read(ORIG_MIG);

  it("select still allows any org member", () => {
    expect(orig).toMatch(
      /create policy tenant_attachments_select[\s\S]*?for select using \(org_id in \(select public\.current_org_ids\(\)\)\)/i,
    );
  });

  it("insert still allows any org member", () => {
    expect(orig).toMatch(
      /create policy tenant_attachments_insert[\s\S]*?for insert with check \(org_id in \(select public\.current_org_ids\(\)\)\)/i,
    );
  });
});

describe("M-5 contract — deleteTenantAttachment gate pinned in source", () => {
  const svc = read("server/services/tenant-attachments.ts");
  const body = svc.slice(svc.indexOf("export async function deleteTenantAttachment"));

  it("returns forbidden for non owner/admin", () => {
    expect(body).toMatch(/role !== "owner" && role !== "admin"/);
    expect(body).toMatch(/return \{ ok: false, error: "forbidden" \}/);
  });

  it("role gate runs BEFORE the admin client + tenant delete", () => {
    const gateIdx = body.indexOf('error: "forbidden"');
    const adminIdx = body.indexOf("createAdminClient(");
    const deleteIdx = body.indexOf(".delete()");
    expect(gateIdx).toBeGreaterThanOrEqual(0);
    expect(gateIdx).toBeLessThan(adminIdx);
    expect(gateIdx).toBeLessThan(deleteIdx);
  });

  it("ties success to an actually-deleted row, before the audit (no false success)", () => {
    expect(body).toMatch(/if \(!data\) return \{ ok: false, error: "not_deleted" \}/);
    const notDeletedIdx = body.indexOf('error: "not_deleted"');
    const auditIdx = body.indexOf("recordAdminActivity(");
    expect(notDeletedIdx).toBeGreaterThanOrEqual(0);
    expect(notDeletedIdx).toBeLessThan(auditIdx);
  });
});

describe("M-5 contract — Delete control gated to owner/admin in the UI", () => {
  const panel = read("components/attachments/AttachmentsPanel.tsx");
  const client = read("components/attachments/AttachmentsClient.tsx");

  it("panel derives canDelete from owner/admin role and passes it down", () => {
    expect(panel).toMatch(/ctx\.membership\.role === "owner"/);
    expect(panel).toMatch(/ctx\.membership\.role === "admin"/);
    expect(panel).toMatch(/canDelete=\{canDelete\}/);
  });

  it("row only renders the Delete button when canDelete is true", () => {
    expect(client).toMatch(/canDelete: boolean/);
    expect(client).toMatch(/\{canDelete \? \(/);
  });
});
