import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Role & Permissions R3 — owner-controlled admin management (trust boundary).
 *
 * The founder's hard rules proven here:
 *   - Only the OWNER appoints/removes admins and manages admin permissions.
 *   - An admin can manage NORMAL STAFF only with `staff:manage`.
 *   - An admin can NEVER grant itself a permission or escalate.
 * App-layer gates (RLS backstop + a later owner-only memberships RLS migration
 * are separate). Source contracts so a gate can't be silently dropped; plus a
 * behavioural check of the owner/require helpers.
 */

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const codeOf = (ts: string) =>
  ts.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const STAFF = codeOf(read("app/(app)/staff/actions.ts"));
const PERMS = codeOf(read("app/(app)/staff/permission-actions.ts"));

// -- behavioural: the owner gate fails closed ---------------------------------
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
const { isOwner, requireOwner } = await import("@/server/auth/capabilities");
const ctxFor = (role: string | null) =>
  ({ membership: { role, org_id: "o" }, org: { id: "o" } }) as never;

describe("requireOwner — owner-only primitive, fails closed", () => {
  it("isOwner is true ONLY for owner", () => {
    expect(isOwner(ctxFor("owner"))).toBe(true);
    expect(isOwner(ctxFor("admin"))).toBe(false);
    expect(isOwner(ctxFor("staff"))).toBe(false);
    expect(isOwner(ctxFor(null))).toBe(false);
  });
  it("requireOwner redirects a non-owner (admin included)", () => {
    expect(() => requireOwner(ctxFor("admin"))).toThrowError(/NEXT_REDIRECT:\/dashboard\?error=forbidden/);
    expect(() => requireOwner(ctxFor("staff"))).toThrowError(/NEXT_REDIRECT:/);
    expect(() => requireOwner(ctxFor("owner"))).not.toThrow();
  });
});

describe("staff management actions enforce the owner / staff:manage split", () => {
  it("inviteStaff: appointing an admin is owner-only; adding staff needs canManageStaff", () => {
    // admin branch gated by isOwner; staff branch by canManageStaff.
    expect(STAFF).toMatch(/data\.role === "admin"[\s\S]{0,160}isOwner\(ctx\)/);
    expect(STAFF).toMatch(/canManageStaff\(ctx, user\)/);
  });
  it("updateStaffRole: admin-involving OR owner-touching change is owner-only, else staff:manage", () => {
    expect(STAFF).toMatch(
      /requiresOwner\s*=\s*[\s\S]{0,120}parsed\.data\.role === "admin"[\s\S]{0,120}target\?\.role === "admin"[\s\S]{0,60}target\?\.role === "owner"/,
    );
    expect(STAFF).toMatch(/if \(requiresOwner\)\s*\{\s*requireOwner\(ctx\)/);
    expect(STAFF).toMatch(/else if \(!\(await canManageStaff\(ctx, user\)\)\)/);
  });
  it("removeStaff: removing an admin is owner-only, else staff:manage", () => {
    expect(STAFF).toMatch(/target\?\.role === "admin"\)\s*\{\s*requireOwner\(ctx\)/);
  });
  it("admin appoint/remove is audited (incl. appointment via invite)", () => {
    expect(STAFF).toMatch(/recordPermissionEvent/);
    expect(STAFF).toMatch(/"admin_appointed"/);
    expect(STAFF).toMatch(/"admin_removed"/);
    // The existing-user invite path audits the appointment the moment it lands.
    expect(STAFF).toMatch(/via: "inviteStaff"/);
  });
});

describe("setAdminPermissions — owner-only, no self-escalation", () => {
  it("is OWNER-ONLY and returns forbidden otherwise (before any write)", () => {
    const fn = PERMS.slice(PERMS.indexOf("export async function setAdminPermissions"));
    const ownerGate = fn.indexOf("isOwner(ctx)");
    const firstWrite = fn.indexOf('.from("membership_permissions")');
    expect(ownerGate, "must check isOwner").toBeGreaterThan(-1);
    expect(firstWrite, "must write grants").toBeGreaterThan(-1);
    expect(ownerGate, "owner gate must precede any grant write").toBeLessThan(firstWrite);
    expect(fn).toMatch(/if \(!isOwner\(ctx\)\) return \{ ok: false, error: "forbidden" \}/);
  });
  it("refuses editing self and non-admin targets", () => {
    expect(PERMS).toMatch(/targetUserId === user\.id.*cannot_edit_self/);
    expect(PERMS).toMatch(/target\.role !== "admin".*not_an_admin/);
  });
  it("validates every grant against the known taxonomy (no arbitrary module/action, no '*')", () => {
    expect(PERMS).toMatch(/MODULES\.has\(g\.module\)/);
    expect(PERMS).toMatch(/ACTIONS\.has\(g\.action\)/);
    // ACTIONS/MODULES are the TS taxonomy sets (CAP_* has no '*'), so the UI can
    // never persist the owner-only wildcard.
    expect(PERMS).toMatch(/new Set<string>\(CAP_MODULES\)/);
    expect(PERMS).toMatch(/new Set<string>\(CAP_ACTIONS\)/);
  });
  it("writes via the ADMIN client and audits grants_replaced", () => {
    expect(PERMS).toMatch(/createAdminClient\(\)/);
    expect(PERMS).toMatch(/event: "grants_replaced"/);
  });
});
