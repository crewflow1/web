import { afterAll, beforeAll, expect, it } from "vitest";
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
  type OrgSeed,
  type TestOrg,
  type TestUser,
} from "./_fixtures";
import {
  requestAccountDeletion,
  runDeletionRequest,
} from "@/server/services/privacy-deletion";

/**
 * SELF-SERVICE ACCOUNT DELETION — real Postgres + real Supabase Auth.
 *
 * The central distinction under test: a person deleting their own profile is
 * NOT a company deletion. The company, its records, its other people and its
 * files all survive; only what exists FOR the person goes, and what the company
 * must keep stops identifying them.
 */

const created: { orgs: string[]; users: string[] } = { orgs: [], users: [] };

type World = {
  m: Markers; // the SUBJECT's markers
  om: Markers; // everyone else's markers
  owner: TestUser;
  subject: TestUser;
  org: TestOrg;
  seed: OrgSeed;
};

async function buildWorld(prefix: string, opts: { withPayroll: boolean }): Promise<World> {
  const m = newMarkers(`${prefix}s`);
  const om = newMarkers(`${prefix}o`);
  const owner = await mkUser(om, "owner");
  const subject = await mkUser(m, "subject");
  created.users.push(owner.id, subject.id);
  const org = await mkOrg(om, "co", [
    { user: owner, role: "owner" },
    { user: subject, role: "staff" },
  ]);
  created.orgs.push(org.id);
  const seed = await seedOrgBusinessData(org, om);
  await seedMemberFootprint(org, seed, subject, m, { withPayroll: opts.withPayroll });
  await uploadOrgObjects(org.id, om);
  return { m, om, owner, subject, org, seed };
}

const del = (u: TestUser, confirmEmail = u.email) =>
  requestAccountDeletion({ userId: u.id, confirmEmail }, { admin: admin() });

describeIntegration("privacy · self-service account deletion", () => {
  beforeAll(() => undefined);
  afterAll(async () => {
    await cleanup(created.orgs, created.users);
  }, 120_000);

  it("no statutory footprint → the account is truly gone; the company is untouched", async () => {
    const w = await buildWorld("clean", { withPayroll: false });
    // Remove the one authored business record so nothing at all references them.
    await db().from("internal_notes").delete().eq("org_id", w.org.id).eq("author_user_id", w.subject.id);
    // time_entries / leave_requests are retained rows — drop them for the "no footprint" case.
    await db().from("time_entries").delete().eq("org_id", w.org.id).eq("user_id", w.subject.id);
    await db().from("leave_requests").delete().eq("org_id", w.org.id).eq("user_id", w.subject.id);
    const token = await signIn(w.subject);
    expect((await residue(w.m)).length).toBeGreaterThan(8);

    const r = await del(w.subject);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run?.status).toBe("completed");

    // HARD delete: no auth user, no profile, no session.
    expect((await serviceClient().auth.admin.getUserById(w.subject.id)).data.user).toBeNull();
    expect(await countRows("users", { id: w.subject.id })).toBe(0);
    expect((await anonClient().auth.getUser(token)).data.user).toBeNull();
    const relogin = await anonClient().auth.signInWithPassword({ email: w.subject.email, password: w.subject.password });
    expect(relogin.error).not.toBeNull();

    // NO residue anywhere in the database.
    expect(await residue(w.m)).toEqual([]);
    // NI number and date of birth had no payroll line to justify them → deleted.
    expect(await countRows("staff_secrets", { org_id: w.org.id, user_id: w.subject.id })).toBe(0);
    expect(await countRows("payroll_tax_profiles", { org_id: w.org.id, user_id: w.subject.id })).toBe(0);

    const tomb = await ledger(r.requestId);
    expect(tomb.status).toBe("completed");
    expect(tomb.actor_role).toBe("self");
    expect((tomb.steps as { identity: { disposition: string } }).identity.disposition).toBe("hard_deleted");
    expect(tomb.work).toEqual({});
    expect(JSON.stringify(tomb)).not.toContain(w.m.name);

    // THE COMPANY IS NOT DELETED.
    expect(await countRows("organizations", { id: w.org.id })).toBe(1);
    expect(await countRows("customers", { org_id: w.org.id })).toBe(1);
    expect(await countRows("memberships", { org_id: w.org.id })).toBe(1);
    expect(await countOrgObjects(w.org.id)).toBe(4);
    expect((await serviceClient().auth.admin.getUserById(w.owner.id)).data.user?.email).toBe(w.owner.email);
  }, 120_000);

  it("statutory footprint → retained records survive, pointing at an anonymous placeholder", async () => {
    const w = await buildWorld("stat", { withPayroll: true });
    const token = await signIn(w.subject);
    const r = await del(w.subject);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run?.status).toBe("completed");

    // DELETE class — gone.
    for (const t of ["memberships", "notifications", "notification_preferences", "push_subscriptions", "job_assignments", "rota_entries"]) {
      expect(await countRows(t, { org_id: w.org.id, user_id: w.subject.id }), t).toBe(0);
    }
    expect(await countRows("staff_compensation", { user_id: w.subject.id })).toBe(0);

    // RETAIN class — the payroll line is still there, still linked to the same id.
    expect(await countRows("payroll_lines", { org_id: w.org.id, user_id: w.subject.id })).toBe(1);
    // CONDITIONAL — the NI number stays BECAUSE payroll still needs it.
    expect(await countRows("staff_secrets", { org_id: w.org.id, user_id: w.subject.id })).toBe(1);

    // SCRUB class — row kept, personal detail blanked.
    const te = await db().from("time_entries").select("*").eq("org_id", w.org.id).eq("user_id", w.subject.id).single();
    const entry = te.data as Record<string, unknown>;
    expect(entry.started_at).toBeTruthy();
    expect(entry.ended_at).toBeTruthy();
    expect(entry.note).toBeNull();
    expect(entry.gps_lat).toBeNull();
    expect(entry.gps_lng).toBeNull();
    const lr = await db().from("leave_requests").select("*").eq("org_id", w.org.id).eq("user_id", w.subject.id).single();
    const leave = lr.data as Record<string, unknown>;
    expect(leave.type).toBe("sick");
    expect(leave.starts_at).toBe("2026-10-12");
    expect(leave.reason).toBeNull();

    // PSEUDONYMISE class — the authored business record is intact and still attributed.
    const note = await db().from("internal_notes").select("*").eq("org_id", w.org.id).eq("author_user_id", w.subject.id).single();
    expect((note.data as Record<string, unknown>).body).toBe("Customer prefers morning visits.");

    // The identity behind the id is a placeholder.
    const profile = await db().from("users").select("*").eq("id", w.subject.id).single();
    const p = profile.data as Record<string, unknown>;
    expect(p.full_name).toBe("Deleted user");
    expect(p.email).toBe(`deleted-${w.subject.id}@deleted.invalid`);
    expect(p.phone).toBeNull();
    const auth = await serviceClient().auth.admin.getUserById(w.subject.id);
    const au = auth.data.user as unknown as Record<string, unknown> | null;
    expect(au, "soft-deleted auth row remains for the FK").not.toBeNull();
    expect(String(au?.email ?? "")).not.toContain("deletion-ws.invalid");
    expect(au?.user_metadata).toEqual({});
    expect(au?.deleted_at).toBeTruthy();

    // Sessions revoked; cannot sign in again with the old credentials.
    expect((await anonClient().auth.getUser(token)).data.user).toBeNull();
    const relogin = await anonClient().auth.signInWithPassword({ email: w.subject.email, password: w.subject.password });
    expect(relogin.error).not.toBeNull();

    // Catalogue-driven residue: NOTHING carrying the person's markers remains.
    expect(await residue(w.m)).toEqual([]);

    const tomb = await ledger(r.requestId);
    const identity = (tomb.steps as { identity: { disposition: string } }).identity;
    expect(identity.disposition).toBe("anonymised_placeholder");
    const step = (tomb.steps as Record<string, { retained: Record<string, number>; scrubbed: Record<string, number>; deleted: Record<string, number> }>)[
      `erase_org:${w.org.id}`
    ];
    expect(step.retained["payroll_lines.user_id"]).toBe(1);
    expect(step.retained["staff_secrets.user_id"]).toBe(1);
    expect(step.scrubbed.time_entries).toBe(1);
    expect(step.deleted.memberships).toBe(1);

    // Re-running is a no-op; a second request cannot be created (the profile no
    // longer carries that email).
    expect((await runDeletionRequest(r.requestId, { admin: admin() })).status).toBe("not_claimed");
    const second = await del(w.subject);
    expect(second.ok).toBe(false);
  }, 120_000);

  it("a sole owner must delete the company first; a co-owner may leave", async () => {
    const m = newMarkers("solo");
    const solo = await mkUser(m, "solo");
    const co = await mkUser(m, "coowner");
    created.users.push(solo.id, co.id);
    const org = await mkOrg(m, "soleco", [{ user: solo, role: "owner" }]);
    created.orgs.push(org.id);

    const refused = await del(solo);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.code).toBe("sole_owner");
      expect(refused.message).toMatch(/only owner/i);
    }
    expect(await countRows("privacy_deletion_requests", { target_user_id: solo.id })).toBe(0);
    expect((await serviceClient().auth.admin.getUserById(solo.id)).data.user?.email).toBe(solo.email);

    // With a second owner the first may delete their account; the company lives on.
    await db().from("memberships").insert({ org_id: org.id, user_id: co.id, role: "owner" });
    const ok = await del(solo);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.run?.status).toBe("completed");
    expect(await countRows("organizations", { id: org.id })).toBe(1);
    expect(await countRows("memberships", { org_id: org.id })).toBe(1);
    expect((await serviceClient().auth.admin.getUserById(solo.id)).data.user).toBeNull();
  }, 120_000);

  it("race: the co-owner is demoted after the request is recorded → cancelled, nothing deleted", async () => {
    const m = newMarkers("orph");
    const a = await mkUser(m, "ownera");
    const b = await mkUser(m, "ownerb");
    created.users.push(a.id, b.id);
    const org = await mkOrg(m, "twoowners", [
      { user: a, role: "owner" },
      { user: b, role: "owner" },
    ]);
    created.orgs.push(org.id);

    // Record the request WITHOUT running it (as if the runner were about to start)…
    const createdReq = await db().rpc("privacy_request_create", {
      p_kind: "user_account",
      p_target_org_id: null,
      p_target_user_id: a.id,
      p_actor_user_id: a.id,
      p_confirm: a.email,
      p_cooling_off_seconds: 0,
    });
    expect(createdReq.error, createdReq.error?.message).toBeNull();
    const requestId = String((createdReq.data as { request_id: string }).request_id);
    // …then the other owner is demoted, leaving `a` the sole owner.
    await db().from("memberships").update({ role: "staff" }).eq("org_id", org.id).eq("user_id", b.id);

    const run = await runDeletionRequest(requestId, { admin: admin() });
    expect(run).toMatchObject({ status: "cancelled", reason: "sole_owner" });
    expect((await ledger(requestId)).cancelled_reason).toBe("sole_owner");
    expect(await countRows("memberships", { org_id: org.id })).toBe(2);
    expect((await serviceClient().auth.admin.getUserById(a.id)).data.user?.email).toBe(a.email);
    const p = await db().from("users").select("full_name").eq("id", a.id).single();
    expect((p.data as { full_name: string }).full_name).toContain(m.name);
  }, 120_000);

  it("authorisation: nobody can delete someone else's account; the email must match", async () => {
    const w = await buildWorld("authz", { withPayroll: false });
    // The owner of the person's company tries to delete the person's ACCOUNT.
    for (const actor of [w.owner]) {
      const r = await db().rpc("privacy_request_create", {
        p_kind: "user_account",
        p_target_org_id: null,
        p_target_user_id: w.subject.id,
        p_actor_user_id: actor.id,
        p_confirm: w.subject.email,
        p_cooling_off_seconds: 0,
      });
      expect(r.error?.code).toBe("42501");
    }
    for (const wrong of ["", "DELETE", w.owner.email, `x${w.subject.email}`]) {
      const r = await del(w.subject, wrong);
      expect(r.ok, `confirm="${wrong}"`).toBe(false);
      if (!r.ok) expect(r.code).toBe("confirmation");
    }
    // Email comparison is case-insensitive (it is the address, not a password).
    expect(await countRows("privacy_deletion_requests", { target_user_id: w.subject.id })).toBe(0);
    expect((await serviceClient().auth.admin.getUserById(w.subject.id)).data.user?.email).toBe(w.subject.email);
    expect(await countRows("memberships", { org_id: w.org.id, user_id: w.subject.id })).toBe(1);
  }, 120_000);

  it("member of several companies: erased from each; interrupted between them, then resumed; other tenant bytes unchanged", async () => {
    const w = await buildWorld("multi", { withPayroll: true });
    // A second company the subject also works for, with its own owner.
    const om2 = newMarkers("multi2");
    const owner2 = await mkUser(om2, "owner2");
    created.users.push(owner2.id);
    const org2 = await mkOrg(om2, "co2", [
      { user: owner2, role: "owner" },
      { user: w.subject, role: "admin" },
    ]);
    created.orgs.push(org2.id);
    const seed2 = await seedOrgBusinessData(org2, om2);
    // (staff_compensation is one row per user — already seeded for org 1.)
    await db().from("notifications").insert({ org_id: org2.id, user_id: w.subject.id, type: "info", title: `For ${w.m.name}` });
    await db().from("job_assignments").insert({ org_id: org2.id, job_id: seed2.job, user_id: w.subject.id });

    // An unrelated third company: must be byte-for-byte unaffected.
    const xm = newMarkers("multix");
    const xOwner = await mkUser(xm, "xowner");
    created.users.push(xOwner.id);
    const orgX = await mkOrg(xm, "cox", [{ user: xOwner, role: "owner" }]);
    created.orgs.push(orgX.id);
    const seedX = await seedOrgBusinessData(orgX, xm);
    await seedMemberFootprint(orgX, seedX, xOwner, xm, { withPayroll: true });
    await uploadOrgObjects(orgX.id, xm);
    const before = await snapshotOrg(orgX.id, [xOwner.id, owner2.id, w.owner.id]);

    // Die after the FIRST org is erased.
    let n = 0;
    const createdReq = await db().rpc("privacy_request_create", {
      p_kind: "user_account",
      p_target_org_id: null,
      p_target_user_id: w.subject.id,
      p_actor_user_id: w.subject.id,
      p_confirm: w.subject.email.toUpperCase(),
      p_cooling_off_seconds: 0,
    });
    expect(createdReq.error, createdReq.error?.message).toBeNull();
    const requestId = String((createdReq.data as { request_id: string }).request_id);
    const crashed = await runDeletionRequest(requestId, {
      admin: admin(),
      afterStep: (s) => {
        if (s.startsWith("erase_org:") && ++n === 1) throw new Error("simulated crash");
      },
    });
    expect(crashed.status).toBe("failed");
    const mid = await ledger(requestId);
    const doneOrgs = Object.keys(mid.steps as object).filter((k) => k.startsWith("erase_org:"));
    expect(doneOrgs.length).toBe(1);
    // Half-way: exactly one of the two memberships is gone, and the account still exists.
    expect(await countRows("memberships", { user_id: w.subject.id })).toBe(1);
    expect((await serviceClient().auth.admin.getUserById(w.subject.id)).data.user?.email).toBe(w.subject.email);

    const seen: string[] = [];
    const resumed = await runDeletionRequest(requestId, {
      admin: admin(),
      afterStep: (s) => {
        seen.push(s);
      },
    });
    expect(resumed.status).toBe("completed");
    expect(seen.filter((s) => s.startsWith("erase_org:")).length, "the finished org is not redone").toBe(1);
    expect(seen).not.toContain(doneOrgs[0]);

    expect(await countRows("memberships", { user_id: w.subject.id })).toBe(0);
    expect(await countRows("notifications", { user_id: w.subject.id })).toBe(0);
    expect(await countRows("job_assignments", { user_id: w.subject.id })).toBe(0);
    expect(await countRows("payroll_lines", { org_id: w.org.id, user_id: w.subject.id })).toBe(1);
    expect(await residue(w.m)).toEqual([]);
    // Both companies still exist with their owners and their data.
    for (const o of [w.org, org2]) {
      expect(await countRows("organizations", { id: o.id })).toBe(1);
      expect(await countRows("customers", { org_id: o.id })).toBe(1);
      expect(await countRows("memberships", { org_id: o.id })).toBe(1);
    }
    expect(await snapshotOrg(orgX.id, [xOwner.id, owner2.id, w.owner.id])).toBe(before);
  }, 180_000);

  it("concurrent double submit: one request, one deletion", async () => {
    const w = await buildWorld("dbl", { withPayroll: true });
    const [a, b] = await Promise.all([del(w.subject), del(w.subject)]);
    const oks = [a, b].filter((r) => r.ok);
    expect(oks.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(oks.map((r) => (r.ok ? r.requestId : "")));
    expect(ids.size).toBe(1);
    expect(await countRows("privacy_deletion_requests", { target_user_id: w.subject.id })).toBe(1);
    const statuses = oks.map((r) => (r.ok ? r.run?.status : "")).sort();
    expect(statuses).toContain("completed");
    expect((await ledger([...ids][0])).status).toBe("completed");
    expect(await countRows("payroll_lines", { org_id: w.org.id, user_id: w.subject.id })).toBe(1);
    expect(await residue(w.m)).toEqual([]);
  }, 120_000);
});
