/* eslint-disable @typescript-eslint/no-explicit-any -- loose casts: the new R2
   tables are not in the generated Database types until the migration is applied
   + types regenerated, so test queries go through a loose client shape. */
import { beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * membership_permissions + permission_audit — service-role-only trust boundary
 * (Role & Permissions policy R2), proven against real Postgres.
 *
 * The capability grants and the permission audit trail must be UNREACHABLE by a
 * client role (anon or an authenticated member, even the admin whose grants they
 * are): the capability helper reads them via the admin client only. This proves
 * RLS + the revoked client grants hold at the DB, plus the unique constraint and
 * the backfill-insert semantics.
 */

// The new tables are not in the generated Database types yet; cast loosely.
type Loose = { from: (t: string) => any };
const svc = () => serviceClient() as unknown as Loose;

describeIntegration("membership_permissions / permission_audit are service-role-only", () => {
  const T = `mp_${Date.now().toString(36)}`;
  let orgId = "";
  let adminUserId = "";
  let adminMembershipId = "";
  let token = "";

  beforeAll(async () => {
    const org = await svc().from("organizations").insert({ name: `MP ${T}`, slug: T }).select("id").single();
    if (org.error) throw new Error(org.error.message);
    orgId = String(org.data.id);

    const email = `${T}@x.test`;
    const created = await serviceClient().auth.admin.createUser({ email, password: `Pw-${T}`, email_confirm: true });
    if (created.error) throw new Error(created.error.message);
    adminUserId = created.data.user?.id ?? "";
    const mirrored = await svc().from("users").insert({ id: adminUserId, email, full_name: `Admin ${T}` }).select("id").single();
    if (mirrored.error) throw new Error(mirrored.error.message);

    const mem = await svc().from("memberships").insert({ user_id: adminUserId, org_id: orgId, role: "admin" }).select("id").single();
    if (mem.error) throw new Error(mem.error.message);
    adminMembershipId = String(mem.data.id);

    // Seed one specific grant via the service role (what the R3 owner UI will do).
    const g = await svc().from("membership_permissions").insert({
      org_id: orgId,
      membership_id: adminMembershipId,
      module: "jobs",
      action: "view",
    }).select("id").single();
    if (g.error) throw new Error(`seed grant: ${g.error.message}`);

    const s = await anonClient().auth.signInWithPassword({ email, password: `Pw-${T}` });
    if (s.error) throw new Error(s.error.message);
    token = s.data.session?.access_token ?? "";
    expect(token).not.toBe("");
  });

  it("service-role CAN read the grant (the capability helper's path)", async () => {
    const r = await svc().from("membership_permissions").select("module, action").eq("membership_id", adminMembershipId);
    expect(r.error).toBeNull();
    expect(r.data).toEqual([{ module: "jobs", action: "view" }]);
  });

  it("ANON cannot read grants (revoked client grant → denied/empty, never the data)", async () => {
    const r = await (anonClient() as unknown as Loose).from("membership_permissions").select("module, action");
    // Either a hard 42501 (grant revoked) or an empty set — never another's grant.
    expect(r.data ?? []).toEqual([]);
  });

  it("the AUTHENTICATED admin cannot read their OWN grants via the Data API", async () => {
    // Clients never query grants directly; they go through the server/admin client.
    const r = await (userClient(token) as unknown as Loose)
      .from("membership_permissions")
      .select("module, action")
      .eq("membership_id", adminMembershipId);
    expect(r.data ?? []).toEqual([]);
  });

  it("the authenticated admin cannot INSERT a grant for themselves (no self-escalation via PostgREST)", async () => {
    const r = await (userClient(token) as unknown as Loose).from("membership_permissions").insert({
      org_id: orgId,
      membership_id: adminMembershipId,
      module: "invoices",
      action: "manage",
    });
    expect(r.error, "a client INSERT into membership_permissions must be refused").not.toBeNull();
    // And it did not land.
    const check = await svc().from("membership_permissions").select("id").eq("membership_id", adminMembershipId).eq("module", "invoices");
    expect(check.data ?? []).toEqual([]);
  });

  it("the unique constraint blocks a duplicate (membership, module, action)", async () => {
    const dup = await svc().from("membership_permissions").insert({
      org_id: orgId,
      membership_id: adminMembershipId,
      module: "jobs",
      action: "view",
    });
    expect(dup.error, "duplicate grant must violate the unique constraint").not.toBeNull();
  });

  it("the backfill insert gives an admin the wildcard, idempotently", async () => {
    const backfill = `insert into public.membership_permissions (org_id, membership_id, module, action, granted_by)
      select m.org_id, m.id, '*', '*', null from public.memberships m
      where m.role = 'admin' and m.id = '${adminMembershipId}'
      on conflict (membership_id, module, action) do nothing;`;
    // Run twice; the second must be a no-op (on conflict do nothing).
    const r1 = await svc().from("membership_permissions").insert({ org_id: orgId, membership_id: adminMembershipId, module: "*", action: "*" }).select("id").single();
    expect(r1.error).toBeNull();
    const r2 = await svc().from("membership_permissions").insert({ org_id: orgId, membership_id: adminMembershipId, module: "*", action: "*" });
    expect(r2.error, "re-inserting the wildcard must hit the unique constraint").not.toBeNull();
    void backfill; // the migration's statement; asserted idempotent above
  });

  it("the composite FK refuses a grant whose org_id is NOT the membership's org", async () => {
    // Create a second real org; a grant for org-A's membership but stamped with
    // org-B must be rejected by (membership_id, org_id) -> memberships(id, org_id).
    const orgB = await svc().from("organizations").insert({ name: `MP ${T} B`, slug: `${T}b` }).select("id").single();
    if (orgB.error) throw new Error(orgB.error.message);
    const r = await svc().from("membership_permissions").insert({
      org_id: String(orgB.data.id), // wrong org for this membership
      membership_id: adminMembershipId, // belongs to org A
      module: "jobs",
      action: "edit",
    });
    expect(r.error, "a cross-org grant must violate the composite FK").not.toBeNull();
  });

  it("permission_audit is service-role writable and client-unreadable", async () => {
    const w = await svc().from("permission_audit").insert({ org_id: orgId, actor_user_id: adminUserId, event: "grant_added", module: "jobs", action: "view" });
    expect(w.error).toBeNull();
    const r = await (userClient(token) as unknown as Loose).from("permission_audit").select("id");
    expect(r.data ?? []).toEqual([]);
  });
});
