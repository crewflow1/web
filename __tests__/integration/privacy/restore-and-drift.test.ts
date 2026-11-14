import { afterAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import {
  admin,
  cleanup,
  countOrgObjects,
  countRows,
  db,
  makeDue,
  mkOrg,
  mkUser,
  newMarkers,
  residue,
  seedMemberFootprint,
  seedOrgBusinessData,
  stripeMock,
  uploadOrgObjects,
} from "./_fixtures";
import {
  exportTombstones,
  reapplyTombstones,
  requestAccountDeletion,
  requestOrgDeletion,
  runDeletionRequest,
} from "@/server/services/privacy-deletion";
import {
  USER_ERASE_ACCOUNT_GLOBAL_REFS,
  USER_ERASE_CLASSIFIED_REFS,
  USER_ERASE_EMPLOYER_GLOBAL_REFS,
} from "@/lib/gdpr/user-erasure";
import { ERASE_STORAGE_BUCKETS } from "@/lib/gdpr/erase-tables";

const created: { orgs: string[]; users: string[] } = { orgs: [], users: [] };

describeIntegration("privacy · backup restore re-applies tombstones", () => {
  afterAll(async () => {
    await cleanup(created.orgs, created.users);
  }, 120_000);

  it("a restored company is deleted again from its tombstone alone", async () => {
    const m = newMarkers("rst");
    const owner = await mkUser(m, "owner");
    created.users.push(owner.id);
    const org = await mkOrg(m, "co", [{ user: owner, role: "owner" }]);
    created.orgs.push(org.id);
    await seedOrgBusinessData(org, m);
    await uploadOrgObjects(org.id, m);

    const req = await requestOrgDeletion({ orgId: org.id, actorUserId: owner.id, confirmName: org.name }, { admin: admin() });
    expect(req.ok).toBe(true);
    if (!req.ok) return;
    await makeDue(req.requestId);
    expect((await runDeletionRequest(req.requestId, { admin: admin(), stripe: stripeMock() })).status).toBe("completed");
    expect(await countRows("organizations", { id: org.id })).toBe(0);

    // The tombstone as the off-platform backup would carry it: opaque only.
    const tombstones = (await exportTombstones(null, { admin: admin() })).filter((t) => t.id === req.requestId);
    expect(tombstones.length).toBe(1);
    const original = tombstones[0];
    if (!original) return;
    expect(Object.keys(original).sort()).toEqual(
      ["completed_at", "id", "kind", "retention_until", "target_org_id", "target_user_id"],
    );
    expect(JSON.stringify(original)).not.toContain(m.name);

    // With the tombstone still honoured, re-applying is a no-op.
    expect(await reapplyTombstones(tombstones, { admin: admin() })).toEqual([
      { tombstoneId: req.requestId, outcome: "already_applied" },
    ]);

    // ── SIMULATED RESTORE of a backup taken BEFORE the deletion ─────────────
    // The company is back under its ORIGINAL id (a restore preserves ids) with a
    // member, data and a file — and the restored ledger has no tombstone. The
    // sealed row cannot be removed (it is evidence), so the "pre-deletion
    // ledger" is simulated by presenting the tombstone under a new id, exactly
    // as a ledger that never saw it would look.
    const owner2 = await mkUser(m, "restored");
    created.users.push(owner2.id);
    const back = await db().from("organizations").insert({ id: org.id, name: org.name, slug: org.slug, status: "active" });
    expect(back.error, back.error?.message).toBeNull();
    await db().from("memberships").insert({ org_id: org.id, user_id: owner2.id, role: "owner" });
    await db().from("customers").insert({ org_id: org.id, name: `${m.name} Restored Customer` });
    await uploadOrgObjects(org.id, m);
    const lost = { ...original, id: crypto.randomUUID() };

    const out = await reapplyTombstones([lost], { admin: admin(), stripe: stripeMock() });
    expect(out).toEqual([{ tombstoneId: lost.id, outcome: "reapply_scheduled", run: "completed" }]);

    expect(await countRows("organizations", { id: org.id })).toBe(0);
    expect(await countRows("customers", { org_id: org.id })).toBe(0);
    expect(await countOrgObjects(org.id)).toBe(0);
    expect((await serviceClient().auth.admin.getUserById(owner2.id)).data.user).toBeNull();
    expect(await residue(m)).toEqual([]);

    const again = await db().from("privacy_deletion_requests").select("*").eq("reapply_of", lost.id).single();
    const row = again.data as Record<string, unknown>;
    expect(row.actor_role).toBe("restore_reapply");
    expect(row.actor_user_id).toBeNull();
    expect(row.status).toBe("completed");
    // …and re-applying the same tombstone a second time does nothing.
    expect(await reapplyTombstones([lost], { admin: admin() })).toEqual([
      { tombstoneId: lost.id, outcome: "already_applied" },
    ]);
    // A tombstone whose target never came back needs nothing.
    const absent = { ...original, id: crypto.randomUUID(), target_org_id: crypto.randomUUID() };
    expect(await reapplyTombstones([absent], { admin: admin() })).toEqual([
      { tombstoneId: absent.id, outcome: "nothing_to_reapply" },
    ]);
  }, 180_000);

  it("a restored person (placeholder un-done by the restore) is erased again", async () => {
    const m = newMarkers("rsu");
    const om = newMarkers("rsuo");
    const owner = await mkUser(om, "owner");
    const subject = await mkUser(m, "subject");
    created.users.push(owner.id, subject.id);
    const org = await mkOrg(om, "co", [
      { user: owner, role: "owner" },
      { user: subject, role: "staff" },
    ]);
    created.orgs.push(org.id);
    const seed = await seedOrgBusinessData(org, om);
    await seedMemberFootprint(org, seed, subject, m, { withPayroll: true });

    const r = await requestAccountDeletion({ userId: subject.id, confirmEmail: subject.email }, { admin: admin() });
    expect(r.ok && r.run?.status === "completed").toBe(true);
    if (!r.ok) return;
    const [tomb] = (await exportTombstones(null, { admin: admin() })).filter((t) => t.id === r.requestId);
    expect(tomb, "the completed account deletion is exported as a tombstone").toBeDefined();
    if (!tomb) return;
    expect(tomb.kind).toBe("user_account");
    expect(await residue(m)).toEqual([]);

    // SIMULATED RESTORE: the profile, the membership and personal rows are back.
    await db().from("users").update({ email: subject.email, full_name: `${m.name} subject`, phone: m.phone }).eq("id", subject.id);
    await db().from("memberships").insert({ org_id: org.id, user_id: subject.id, role: "staff" });
    await db().from("notifications").insert({ org_id: org.id, user_id: subject.id, type: "info", title: `Back: ${m.name}` });
    expect((await residue(m)).length).toBeGreaterThan(0);

    const lost = { ...tomb, id: crypto.randomUUID() };
    const out = await reapplyTombstones([lost], { admin: admin() });
    expect(out).toEqual([{ tombstoneId: lost.id, outcome: "reapply_scheduled", run: "completed" }]);
    expect(await residue(m)).toEqual([]);
    expect(await countRows("memberships", { user_id: subject.id })).toBe(0);
    expect(await countRows("payroll_lines", { org_id: org.id, user_id: subject.id })).toBe(1);
    expect(await countRows("organizations", { id: org.id })).toBe(1);
  }, 180_000);
});

describeIntegration("privacy · catalogue drift guards", () => {
  type Ref = { tbl: string; col: string; on_delete: string; not_null: boolean; org_scoped: boolean };

  it("every HARD user reference is classified (a new one fails here, and in the primitive)", async () => {
    const r = await db().rpc("_privacy_introspect_user_refs");
    expect(r.error, r.error?.message).toBeNull();
    const refs = (r.data as Ref[]) ?? [];
    expect(refs.length).toBeGreaterThan(200);
    const hard = refs.filter((x) => x.not_null || x.on_delete === "cascade" || x.on_delete === "restrict");
    const classified = new Set(USER_ERASE_CLASSIFIED_REFS);
    const globals = new Set([...USER_ERASE_ACCOUNT_GLOBAL_REFS, ...USER_ERASE_EMPLOYER_GLOBAL_REFS]);

    const unclassifiedOrg = hard.filter((x) => x.org_scoped && !classified.has(`${x.tbl}.${x.col}`));
    expect(
      unclassifiedOrg.map((x) => `${x.tbl}.${x.col}`),
      "classify these in lib/gdpr/user-erasure.json (delete / scrub / conditional / retain)",
    ).toEqual([]);
    const unclassifiedGlobal = hard.filter((x) => !x.org_scoped && !globals.has(`${x.tbl}.${x.col}`));
    expect(
      unclassifiedGlobal.map((x) => `${x.tbl}.${x.col}`),
      "a user-keyed table with no org_id must be listed in account_global",
    ).toEqual([]);

    // No dead entries: every classified reference exists in the live schema.
    // activity_log.actor_id is a user id WITHOUT a foreign key (the audit trail
    // must outlive the user row), so it is not in the FK listing by design.
    const NON_FK_USER_COLUMNS = new Set(["activity_log.actor_id"]);
    const live = new Set(refs.map((x) => `${x.tbl}.${x.col}`));
    const dead = [...classified, ...globals].filter((x) => !live.has(x) && !NON_FK_USER_COLUMNS.has(x));
    expect(dead, "registry entries that no longer exist in the schema").toEqual([]);
  });

  it("every delete guard on a tenant table lets the teardown cascade through", async () => {
    const r = await db().rpc("_privacy_introspect_delete_guards");
    expect(r.error, r.error?.message).toBeNull();
    const guards = (r.data as Array<{ tbl: string; fn: string; has_org_escape: boolean }>) ?? [];
    expect(guards.length).toBeGreaterThan(40);
    // Guards that test the PARENT row instead ("parent already gone → allow"):
    // reviewed, safe in a cascade because the parent is deleted first.
    const PARENT_CHECKED = new Set([
      "tg_goods_received_line_draft_only",
      "tg_material_request_line_draft_only",
      "tg_permit_condition_block_delete",
      "tg_rah_block_delete_when_issued",
    ]);
    const blocking = guards.filter((g) => !g.has_org_escape && !PARENT_CHECKED.has(g.fn));
    expect(
      blocking.map((g) => `${g.tbl} ← ${g.fn}`),
      "a delete guard with no teardown escape makes every tenant holding such a row undeletable",
    ).toEqual([]);
  });

  it("the storage bucket census covers every live bucket", async () => {
    const r = await db().rpc("_privacy_introspect_buckets");
    expect(r.error, r.error?.message).toBeNull();
    const live = ((r.data as Array<{ bucket: string }>) ?? []).map((b) => b.bucket);
    expect(live.length).toBeGreaterThan(5);
    const missing = live.filter((b) => !ERASE_STORAGE_BUCKETS.includes(b));
    expect(missing, "add to ERASE_STORAGE_BUCKETS (lib/gdpr/erase-tables.ts) or files will survive a deletion").toEqual([]);
  });

  it("the residue scan refuses markers too short to prove anything", async () => {
    const r = await db().rpc("privacy_residue_scan", { p_markers: ["abc"] });
    expect(r.error?.message ?? "").toMatch(/at least 6 characters/);
  });
});
