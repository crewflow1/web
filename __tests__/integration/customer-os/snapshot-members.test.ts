import { afterAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { loadCustomerSnapshot } from "@/server/services/hq-customer-snapshot";
import { CURRENT_TOS_VERSION } from "@/lib/legal/tos";

/**
 * HQ customer snapshot — member roster + ToS surfacing, real Postgres
 * (L11 items 3 + 5).
 *
 * Runs the REAL loadCustomerSnapshot (service-role, exactly as the
 * /admin/customers/[id] page calls it) against a fixture org and proves:
 *
 *   • every member comes back — owner AND non-owner — with identity +
 *     role + join date only (the CustomerMember shape has no pay keys);
 *   • the roster is org-pinned: a member of ANOTHER org never appears;
 *   • the ToS stamp written at org creation is surfaced on org.*.
 */

const T = `snapm-${Date.now().toString(36)}`;
const svc = () => serviceClient();

const userIds: string[] = [];
const orgIds: string[] = [];

async function makeUser(suffix: string): Promise<string> {
  const email = `${T}-${suffix}@example.test`;
  const created = await svc().auth.admin.createUser({
    email,
    password: `Pw-${T}-${suffix}-${Math.random().toString(36).slice(2)}`,
    email_confirm: true,
  });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  userIds.push(id);
  const mirrored = await svc()
    .from("users")
    .insert({ id, email, full_name: `Member ${suffix}` });
  expect(mirrored.error, mirrored.error?.message).toBeNull();
  return id;
}

async function makeOrg(suffix: string): Promise<string> {
  const { data, error } = await svc()
    .from("organizations")
    .insert({ name: `Snap Members ${suffix}`, slug: `${T}-${suffix}` })
    .select("id")
    .single();
  expect(error, error?.message).toBeNull();
  const id = data?.id ?? "";
  orgIds.push(id);
  return id;
}

describeIntegration("hq customer snapshot — members + ToS (real Postgres)", () => {
  afterAll(async () => {
    for (const org of orgIds) {
      await svc().from("memberships").delete().eq("org_id", org);
      await svc().from("organizations").delete().eq("id", org);
    }
    for (const u of userIds) {
      await svc().from("users").delete().eq("id", u);
      await svc().auth.admin.deleteUser(u);
    }
  });

  it("lists every member of THIS org (identity only) and surfaces the ToS stamp", async () => {
    const orgId = await makeOrg("main");
    const otherOrgId = await makeOrg("other");

    const ownerId = await makeUser("owner");
    const staffId = await makeUser("staff");
    const outsiderId = await makeUser("outsider");

    const mems = await svc().from("memberships").insert([
      { org_id: orgId, user_id: ownerId, role: "owner" },
      { org_id: orgId, user_id: staffId, role: "staff" },
      { org_id: otherOrgId, user_id: outsiderId, role: "owner" },
    ]);
    expect(mems.error, mems.error?.message).toBeNull();

    // The stamp the onboarding action writes at org creation.
    const stamped = await (svc().from("organizations") as never as {
      update: (v: unknown) => {
        eq: (k: string, v: string) => Promise<{ error: { message: string } | null }>;
      };
    })
      .update({
        tos_accepted_at: new Date().toISOString(),
        tos_accepted_by: ownerId,
        tos_version: CURRENT_TOS_VERSION,
      })
      .eq("id", orgId);
    expect(stamped.error, stamped.error?.message).toBeNull();

    const snap = await loadCustomerSnapshot(orgId);
    expect(snap).not.toBeNull();

    // Complete roster: owner + staff, never the other org's member.
    const ids = snap!.members.map((m) => m.user_id).sort();
    expect(ids).toEqual([ownerId, staffId].sort());
    const roles = new Map(snap!.members.map((m) => [m.user_id, m.role]));
    expect(roles.get(ownerId)).toBe("owner");
    expect(roles.get(staffId)).toBe("staff");

    // Identity-only shape — no pay keys can even be present.
    for (const m of snap!.members) {
      expect(Object.keys(m).sort()).toEqual(
        ["email", "full_name", "joined_at", "role", "user_id"].sort(),
      );
      expect(m.email).toMatch(/@example\.test$/);
      expect(m.joined_at).toBeTruthy();
    }

    // ToS surfaced for the HQ page.
    expect(snap!.org.tos_version).toBe(CURRENT_TOS_VERSION);
    expect(snap!.org.tos_accepted_by).toBe(ownerId);
    expect(snap!.org.tos_accepted_at).not.toBeNull();
  });
});
