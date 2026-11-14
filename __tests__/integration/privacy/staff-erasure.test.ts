import { afterAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient } from "../_harness";
import {
  admin,
  cleanup,
  countOrgObjects,
  countRows,
  db,
  ledger,
  mkOrg,
  mkUser,
  newMarkers,
  residue,
  seedMemberFootprint,
  seedOrgBusinessData,
  signIn,
  snapshotOrg,
  uploadOrgObjects,
  type Markers,
  type TestOrg,
  type TestUser,
} from "./_fixtures";
import { requestStaffErasure, runDeletionRequest } from "@/server/services/privacy-deletion";

/**
 * STAFF ERASURE — an owner/admin removes a staff member from ONE company and
 * erases the personal data that company holds about them. The person's login is
 * theirs and is never touched.
 */

const created: { orgs: string[]; users: string[] } = { orgs: [], users: [] };

type World = {
  m: Markers;
  om: Markers;
  owner: TestUser;
  adminUser: TestUser;
  otherStaff: TestUser;
  subject: TestUser;
  org: TestOrg;
};

async function buildWorld(prefix: string, opts: { withPayroll: boolean }): Promise<World> {
  const m = newMarkers(`${prefix}s`);
  const om = newMarkers(`${prefix}o`);
  const owner = await mkUser(om, "owner");
  const adminUser = await mkUser(om, "admin");
  const otherStaff = await mkUser(om, "staff2");
  const subject = await mkUser(m, "subject");
  created.users.push(owner.id, adminUser.id, otherStaff.id, subject.id);
  const org = await mkOrg(om, "co", [
    { user: owner, role: "owner" },
    { user: adminUser, role: "admin" },
    { user: otherStaff, role: "staff" },
    { user: subject, role: "staff" },
  ]);
  created.orgs.push(org.id);
  const seed = await seedOrgBusinessData(org, om);
  await seedMemberFootprint(org, seed, subject, m, { withPayroll: opts.withPayroll });
  await uploadOrgObjects(org.id, om);
  return { m, om, owner, adminUser, otherStaff, subject, org };
}

const erase = (w: World, actor: TestUser, target: TestUser, confirmEmail = target.email, orgId = w.org.id) =>
  requestStaffErasure(
    { orgId, actorUserId: actor.id, staffUserId: target.id, confirmEmail },
    { admin: admin() },
  );

describeIntegration("privacy · staff erasure by an admin", () => {
  afterAll(async () => {
    await cleanup(created.orgs, created.users);
  }, 120_000);

  it("removes the person from the company and erases what it held — their account survives", async () => {
    const w = await buildWorld("erase", { withPayroll: true });
    const colleagues = [w.owner.id, w.adminUser.id, w.otherStaff.id];
    const r = await erase(w, w.adminUser, w.subject);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run?.status).toBe("completed");

    for (const t of ["memberships", "notifications", "notification_preferences", "push_subscriptions", "job_assignments", "rota_entries"]) {
      expect(await countRows(t, { org_id: w.org.id, user_id: w.subject.id }), t).toBe(0);
    }
    // Retained with reason; scrubbed where the row must stay.
    expect(await countRows("payroll_lines", { org_id: w.org.id, user_id: w.subject.id })).toBe(1);
    expect(await countRows("staff_secrets", { org_id: w.org.id, user_id: w.subject.id })).toBe(1);
    const te = await db().from("time_entries").select("note, gps_lat, started_at").eq("org_id", w.org.id).eq("user_id", w.subject.id).single();
    expect(te.data).toMatchObject({ note: null, gps_lat: null });
    expect((te.data as { started_at: string }).started_at).toBeTruthy();
    // No other membership → the user-keyed pay / emergency-contact row goes too.
    expect(await countRows("staff_compensation", { user_id: w.subject.id })).toBe(0);

    // THE ACCOUNT IS NOT DELETED: same email, can still sign in, profile intact.
    const auth = await serviceClient().auth.admin.getUserById(w.subject.id);
    expect(auth.data.user?.email).toBe(w.subject.email);
    const token = await signIn(w.subject);
    expect((await anonClient().auth.getUser(token)).data.user?.id).toBe(w.subject.id);
    const profile = await db().from("users").select("full_name, email").eq("id", w.subject.id).single();
    expect((profile.data as { full_name: string }).full_name).toContain(w.m.name);

    // Residue: the person's markers survive ONLY in their own, still-live account.
    const left = (await residue(w.m)).filter(
      (x) => !/^(public\.users\.|auth\.users\.|auth\.identities\.|auth\.audit_log_entries\.)/.test(x.location),
    );
    expect(left, JSON.stringify(left)).toEqual([]);

    // Colleagues and the company are untouched.
    expect(await countRows("memberships", { org_id: w.org.id })).toBe(3);
    expect(await countRows("customers", { org_id: w.org.id })).toBe(1);
    expect(await countOrgObjects(w.org.id)).toBe(4);
    for (const id of colleagues) {
      expect((await serviceClient().auth.admin.getUserById(id)).data.user, id).not.toBeNull();
    }

    const tomb = await ledger(r.requestId);
    expect(tomb.status).toBe("completed");
    expect(tomb.actor_role).toBe("admin");
    expect(tomb.kind).toBe("staff_erasure");
    expect(JSON.stringify(tomb)).not.toContain(w.m.name);
    expect((await runDeletionRequest(r.requestId, { admin: admin() })).status).toBe("not_claimed");
  }, 120_000);

  it("no payroll → the NI number is deleted; works in another company → their pay/contact row is left", async () => {
    const w = await buildWorld("nopay", { withPayroll: false });
    const om2 = newMarkers("nopay2");
    const owner2 = await mkUser(om2, "owner2");
    created.users.push(owner2.id);
    const org2 = await mkOrg(om2, "co2", [
      { user: owner2, role: "owner" },
      { user: w.subject, role: "staff" },
    ]);
    created.orgs.push(org2.id);
    const seed2 = await seedOrgBusinessData(org2, om2);
    await db().from("job_assignments").insert({ org_id: org2.id, job_id: seed2.job, user_id: w.subject.id });
    const before2 = await snapshotOrg(org2.id, [owner2.id]);

    const r = await erase(w, w.owner, w.subject);
    expect(r.ok && r.run?.status === "completed").toBe(true);
    if (!r.ok) return;
    expect(await countRows("staff_secrets", { org_id: w.org.id, user_id: w.subject.id })).toBe(0);
    // Still employed by org 2 → the shared, org-less row cannot be attributed to
    // this company, so it is LEFT and reported.
    expect(await countRows("staff_compensation", { user_id: w.subject.id })).toBe(1);
    const step = (await ledger(r.requestId)).steps as Record<string, { retained: Record<string, number> }>;
    expect(step[`erase_org:${w.org.id}`].retained["staff_compensation.user_id:other_membership"]).toBe(1);
    // The OTHER company's data about the same person is byte-for-byte unchanged.
    expect(await snapshotOrg(org2.id, [owner2.id])).toBe(before2);
    expect(await countRows("memberships", { org_id: org2.id, user_id: w.subject.id })).toBe(1);
    expect(await countRows("job_assignments", { org_id: org2.id, user_id: w.subject.id })).toBe(1);
  }, 120_000);

  it("authorisation matrix", async () => {
    const w = await buildWorld("authz", { withPayroll: false });
    const om2 = newMarkers("authz2");
    const outsider = await mkUser(om2, "outsider");
    created.users.push(outsider.id);
    const org2 = await mkOrg(om2, "elsewhere", [{ user: outsider, role: "owner" }]);
    created.orgs.push(org2.id);

    const refused: Array<[string, Promise<Awaited<ReturnType<typeof erase>>>]> = [
      ["staff erasing staff", erase(w, w.otherStaff, w.subject)],
      ["owner of another company", erase(w, outsider, w.subject)],
      ["other company's owner, own org id, foreign target", erase(w, outsider, w.subject, w.subject.email, org2.id)],
      ["admin erasing themselves", erase(w, w.adminUser, w.adminUser)],
      ["admin erasing the owner", erase(w, w.adminUser, w.owner)],
      ["owner erasing themselves", erase(w, w.owner, w.owner)],
      ["the subject erasing themselves this way", erase(w, w.subject, w.subject)],
    ];
    for (const [label, p] of refused) {
      const r = await p;
      expect(r.ok, label).toBe(false);
      if (!r.ok) expect(r.code, label).toBe("forbidden");
    }
    // Admin may not erase another admin; the owner may.
    await db().from("memberships").update({ role: "admin" }).eq("org_id", w.org.id).eq("user_id", w.otherStaff.id);
    const adminOnAdmin = await erase(w, w.adminUser, w.otherStaff);
    expect(adminOnAdmin.ok).toBe(false);
    // Wrong confirmation.
    const wrong = await erase(w, w.owner, w.subject, w.owner.email);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.code).toBe("confirmation");

    expect(await countRows("privacy_deletion_requests", { target_org_id: w.org.id })).toBe(0);
    expect(await countRows("memberships", { org_id: w.org.id })).toBe(4);
    expect(await countRows("notifications", { org_id: w.org.id, user_id: w.subject.id })).toBe(1);

    const ownerOnAdmin = await erase(w, w.owner, w.otherStaff);
    expect(ownerOnAdmin.ok && ownerOnAdmin.run?.status === "completed").toBe(true);
    expect(await countRows("memberships", { org_id: w.org.id })).toBe(3);
  }, 120_000);

  it("a staff-erasure request can never reach the person's login", async () => {
    const w = await buildWorld("nologin", { withPayroll: false });
    const c = await db().rpc("privacy_request_create", {
      p_kind: "staff_erasure",
      p_target_org_id: w.org.id,
      p_target_user_id: w.subject.id,
      p_actor_user_id: w.owner.id,
      p_confirm: w.subject.email,
      p_cooling_off_seconds: 0,
    });
    const requestId = String((c.data as { request_id: string }).request_id);
    await db().rpc("privacy_request_claim", { p_request_id: requestId, p_lease_seconds: 60 });
    const scrub = await db().rpc("privacy_user_identity_scrub", {
      p_request_id: requestId,
      p_user_id: w.subject.id,
      p_global_delete: [],
    });
    expect(scrub.error?.code).toBe("42501");
    // …nor be pointed at a different org than the one it was authorised for.
    const om2 = newMarkers("nologin2");
    const o2 = await mkUser(om2, "o2");
    created.users.push(o2.id);
    const org2 = await mkOrg(om2, "other", [{ user: o2, role: "owner" }, { user: w.subject, role: "staff" }]);
    created.orgs.push(org2.id);
    const hop = await db().rpc("privacy_user_erase_in_org", {
      p_request_id: requestId,
      p_org_id: org2.id,
      p_delete: ["memberships.user_id"],
      p_scrub: [],
      p_conditional: [],
      p_retain: [],
    });
    expect(hop.error?.code).toBe("42501");
    expect(await countRows("memberships", { org_id: org2.id, user_id: w.subject.id })).toBe(1);
    const p = await db().from("users").select("full_name").eq("id", w.subject.id).single();
    expect((p.data as { full_name: string }).full_name).toContain(w.m.name);
    // finish it properly so no live request is left behind
    await db().rpc("privacy_request_fail", { p_request_id: requestId, p_error_code: "test:reset" });
    expect((await runDeletionRequest(requestId, { admin: admin() })).status).toBe("completed");
  }, 120_000);
});
