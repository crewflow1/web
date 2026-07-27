import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Toolbox Talks M1 — DB invariants proven against real Postgres (INV-1..14 from the
 * 8-agent design). Two attack surfaces:
 *
 *   1. Service role (RLS bypassed) — every guard is a TRIGGER, so it must hold even
 *      for the trusted role: born-draft, immutable-on-issue, one-current revision,
 *      same-org link integrity, delete-guard, revision-lineage integrity.
 *   2. Real authenticated member (JWT) — the ACTUAL browser attack surface (the app
 *      ships the anon key; a server action is not a boundary): born-issued denial,
 *      the JWT issue-gate, issued_by/at provenance pinning, and next_tbt_number as a
 *      cross-org count oracle. Mirrors issue-hardening.test.ts for RAMS/permits.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel; maybeSingle(): PromiseLike<Res<Row>> }
interface Upd extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Upd }
interface Del extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Del }
interface Ins extends PromiseLike<Res<Row[]>> { select(c?: string): { single(): PromiseLike<Res<Row>> } }
interface Table { select(c?: string): Sel; insert(r: Row | Row[]): Ins; update(v: Row): Upd; delete(): Del }
const db = (client: unknown) => client as unknown as { from(t: string): Table; rpc(fn: string, a: Row): PromiseLike<Res<unknown>> };
const T = `it-tbt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ===========================================================================
// 1. DB invariants — service role (every guard is a trigger; holds for svc too)
// ===========================================================================
describeIntegration("Toolbox Talks M1 · DB invariants (service role, 20261025)", () => {
  let orgA = "";
  let orgB = "";
  let jobA = "";
  let jobB = "";
  let raB = "";

  const svc = () => db(serviceClient());

  beforeAll(async () => {
    orgA = String((await svc().from("organizations").insert({ name: "TBT A", slug: `${T}-a` }).select("id").single()).data?.id ?? "");
    orgB = String((await svc().from("organizations").insert({ name: "TBT B", slug: `${T}-b` }).select("id").single()).data?.id ?? "");
    jobA = String((await svc().from("jobs").insert({ org_id: orgA, status: "new" }).select("id").single()).data?.id ?? "");
    jobB = String((await svc().from("jobs").insert({ org_id: orgB, status: "new" }).select("id").single()).data?.id ?? "");
    const ra = await svc().from("risk_assessments").insert({ org_id: orgB, title: "B RA", activity: "x" }).select("id").single();
    raB = String(ra.data?.id ?? "");
    if (!orgA || !orgB || !jobA || !jobB || !raB) throw new Error("fixture setup failed");
  });

  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (orgB) await svc().from("organizations").delete().eq("id", orgB);
  });

  it("refuses to INSERT a born-issued talk (born-draft, INV-5)", async () => {
    const r = await svc().from("toolbox_talks")
      .insert({ org_id: orgA, topic: "x", key_points: "y", status: "issued", reference: `${T}-BAD` })
      .select("id").single();
    expect(r.error, "born-issued must be rejected").not.toBeNull();
    expect(r.error?.message ?? "").toMatch(/created as a draft/i);
  });

  it("rejects a talk in org A linked to org B's job / RAMS (INV-3/4)", async () => {
    const j = await svc().from("toolbox_talks").insert({ org_id: orgA, topic: "x", key_points: "y", job_id: jobB }).select("id").single();
    expect(j.error?.message ?? "").toMatch(/not in this organisation/i);
    const ra = await svc().from("toolbox_talks").insert({ org_id: orgA, topic: "x", key_points: "y", risk_assessment_id: raB }).select("id").single();
    expect(ra.error?.message ?? "").toMatch(/not in this organisation/i);
  });

  it("issues a draft, freezes it, enforces one-current + delete-guard (INV-6/10/13)", async () => {
    const draft = await svc().from("toolbox_talks")
      .insert({ org_id: orgA, topic: "Working at height", key_points: "Edge protection", job_id: jobA })
      .select("id, root_toolbox_talk_id, revision_number, status").single();
    const id = String(draft.data?.id);
    expect(draft.error).toBeNull();
    expect(draft.data?.status).toBe("draft");
    expect(draft.data?.root_toolbox_talk_id).toBe(id); // self-roots (INV-11)
    expect(draft.data?.revision_number).toBe(1);

    // issue it (service-role path keeps explicit stamps; the JWT issue-gate is
    // covered below). issued_at satisfies toolbox_talks_issued_stamp.
    const issued = await svc().from("toolbox_talks")
      .update({ status: "issued", reference: "TBT-0001", issued_at: new Date().toISOString() }).eq("id", id);
    expect(issued.error, "draft->issued should succeed").toBeNull();

    // immutable-on-issue (INV-6): editing the topic of an issued talk is rejected
    const edit = await svc().from("toolbox_talks").update({ topic: "TAMPERED" }).eq("id", id);
    expect(edit.error?.message ?? "").toMatch(/immutable/i);

    // one-current (INV-10): a second issued row in the SAME series is rejected
    const dupe = await svc().from("toolbox_talks")
      .insert({ org_id: orgA, topic: "r2", key_points: "z", root_toolbox_talk_id: id, revision_number: 2 })
      .select("id").single();
    const dupeId = String(dupe.data?.id);
    expect(dupe.error, "a second draft revision should insert fine").toBeNull();
    const promote = await svc().from("toolbox_talks")
      .update({ status: "issued", reference: "TBT-0001-R02", issued_at: new Date().toISOString() }).eq("id", dupeId);
    expect(promote.error?.message ?? "", "two issued revisions in one series must be blocked").toMatch(/one_current|duplicate key/i);

    // delete-guard (INV-13): an issued talk cannot be deleted
    const del = await svc().from("toolbox_talks").delete().eq("id", id);
    expect(del.error?.message ?? "").toMatch(/cannot be deleted/i);
  });

  it("rejects self-supersede (INV-11)", async () => {
    const d = await svc().from("toolbox_talks").insert({ org_id: orgA, topic: "s", key_points: "s" }).select("id").single();
    const id = String(d.data?.id);
    const r = await svc().from("toolbox_talks").update({ supersedes_id: id }).eq("id", id);
    expect(r.error?.message ?? "").toMatch(/cannot supersede itself/i);
  });

  it("allows deleting a DRAFT talk (evidence guard is issue-scoped)", async () => {
    const d = await svc().from("toolbox_talks").insert({ org_id: orgA, topic: "throwaway", key_points: "k" }).select("id").single();
    const id = String(d.data?.id);
    const del = await svc().from("toolbox_talks").delete().eq("id", id);
    expect(del.error, "a draft is freely deletable").toBeNull();
  });

  it("[hardening] freezes the Tier-B attendance record (attendees/count/notes) once delivered", async () => {
    const d = await svc().from("toolbox_talks")
      .insert({ org_id: orgA, topic: "Manual handling", key_points: "k", attendees: "J. Smith, K. Patel", attendee_count: 2, notes: "n" })
      .select("id").single();
    const id = String(d.data?.id);
    await svc().from("toolbox_talks").update({ status: "issued", reference: "TBT-FREEZE", issued_at: new Date().toISOString() }).eq("id", id);
    // who attended is the ONLY record for subcontractors who never sign in-app — it must
    // not be silently rewritten on delivered evidence (the frozen tuple now covers it).
    for (const patch of [{ attendees: "TAMPERED — added a name" }, { attendee_count: 9 }, { notes: "rewritten" }]) {
      const edit = await svc().from("toolbox_talks").update(patch).eq("id", id);
      expect(edit.error?.message ?? "", `${Object.keys(patch)[0]} must be frozen once delivered`).toMatch(/immutable/i);
    }
  });
});

// ===========================================================================
// 2. Issue-path hardening — real authenticated member (JWT attack surface)
// ===========================================================================
describeIntegration("Toolbox Talks M1 · issue-path hardening (real member JWT)", () => {
  let orgA = "";
  let orgB = "";
  let uid = "";
  let token = "";
  const FORGED_USER = "00000000-0000-4000-8000-000000000abc";
  const BACKDATE = "2020-01-01T00:00:00Z";
  const svc = () => db(serviceClient());
  const me = () => db(userClient(token));

  beforeAll(async () => {
    orgA = String((await svc().from("organizations").insert({ name: "TBT-M A", slug: `${T}-ma` }).select("id").single()).data?.id ?? "");
    orgB = String((await svc().from("organizations").insert({ name: "TBT-M B", slug: `${T}-mb` }).select("id").single()).data?.id ?? "");
    const created = await serviceClient().auth.admin.createUser({ email: `${T}-m@x.test`, password: `Pw-${T}`, email_confirm: true });
    if (created.error) throw new Error(`createUser: ${created.error.message}`);
    uid = created.data.user?.id ?? "";
    const u = await svc().from("users").insert({ id: uid, email: `${T}-m@x.test`, full_name: "Member" });
    if (u.error) throw new Error(`users insert: ${u.error.message}`);
    // Plain staff of A only (NOT B) — proves the gates fire for any member, and B
    // is the cross-org oracle target.
    const m = await svc().from("memberships").insert({ org_id: orgA, user_id: uid, role: "staff" });
    if (m.error) throw new Error(`membership insert: ${m.error.message}`);
    const signIn = await anonClient().auth.signInWithPassword({ email: `${T}-m@x.test`, password: `Pw-${T}` });
    if (signIn.error) throw new Error(`signIn: ${signIn.error.message}`);
    token = signIn.data.session?.access_token ?? "";
    if (!token) throw new Error("no member token");
    // Sanity: membership must resolve via current_org_ids() (else every gate is vacuous).
    const check = await me().rpc("next_tbt_number", { target_org: orgA });
    if (check.error) throw new Error(`membership not effective: ${check.error.message}`);
  });

  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (orgB) await svc().from("organizations").delete().eq("id", orgB);
    if (uid) await serviceClient().auth.admin.deleteUser(uid);
  });

  async function draft(opts: { keyPoints: boolean }): Promise<string> {
    const r = await me().from("toolbox_talks")
      .insert({ org_id: orgA, topic: "Manual handling", key_points: opts.keyPoints ? "Lift with the legs" : null })
      .select("id").single();
    if (r.error) throw new Error(`draft insert: ${r.error.message}`);
    return String(r.data?.id);
  }

  it("[P0] a member cannot INSERT an already-issued talk (born-a-draft guard)", async () => {
    const { error } = await me().from("toolbox_talks").insert({
      org_id: orgA, topic: "Forged", key_points: "y", status: "issued",
      reference: `TBT-9999`, issued_at: new Date().toISOString(), issued_by: uid,
    }).select("id").single();
    expect(error, "a direct INSERT with status=issued must be rejected").not.toBeNull();
  });

  it("[P0] a member cannot issue a talk with no key points (DB issue-gate)", async () => {
    const id = await draft({ keyPoints: false });
    const ref = String((await me().rpc("next_tbt_number", { target_org: orgA })).data);
    const { error } = await me().from("toolbox_talks")
      .update({ status: "issued", reference: ref }).eq("id", id);
    expect(error?.message ?? "", "issuing with no key points must fail").toMatch(/topic and key points/i);
  });

  it("[hardening] a JWT caller cannot issue a talk without its evidence snapshot", async () => {
    const id = await draft({ keyPoints: true });
    const ref = String((await me().rpc("next_tbt_number", { target_org: orgA })).data);
    const { error } = await me().from("toolbox_talks")
      .update({ status: "issued", reference: ref }).eq("id", id); // no snapshot
    expect(error?.message ?? "", "a null-snapshot issue must be rejected (closes the post-date-the-snapshot hole)")
      .toMatch(/must be delivered with its evidence snapshot/i);
  });

  it("[P1] issuing pins issued_by=caller and issued_at=now — a forged/back-dated issue is ignored", async () => {
    const id = await draft({ keyPoints: true });
    const ref = String((await me().rpc("next_tbt_number", { target_org: orgA })).data);
    const { error } = await me().from("toolbox_talks")
      .update({ status: "issued", reference: ref, issued_at: BACKDATE, issued_by: FORGED_USER, snapshot: { talk_reference: ref, revision: 1, topic: "Manual handling", key_points: "Lift with the legs" } }).eq("id", id);
    expect(error, error?.message).toBeNull();
    const row = (await svc().from("toolbox_talks").select("issued_by, issued_at, status").eq("id", id).maybeSingle()).data;
    expect(row?.status).toBe("issued");
    expect(row?.issued_by, "issued_by must be pinned to the acting member, not the forged id").toBe(uid);
    expect(new Date(String(row?.issued_at)).getTime(), "issued_at must be pinned to now(), not back-dated")
      .toBeGreaterThan(Date.parse("2021-01-01T00:00:00Z"));
  });

  it("[P2] next_tbt_number refuses another org's number, but allows the caller's own (TBT-NNNN)", async () => {
    const foreign = await me().rpc("next_tbt_number", { target_org: orgB });
    expect(foreign.error, "probing another org's talk count must be forbidden").not.toBeNull();
    const own = await me().rpc("next_tbt_number", { target_org: orgA });
    expect(own.error, own.error?.message).toBeNull();
    expect(String(own.data)).toMatch(/^TBT-\d{4}$/);
  });
});

// ===========================================================================
// 3. Post-release-audit hardening (20261030) — the DB is the boundary against a
//    crafted PostgREST/RPC write. Proves: draft can't jump straight to a delivered
//    state (P0), the snapshot is bound to the record (P1), the snapshot allowlist
//    is DB-enforced (P2), and the supervisory lifecycle is owner/admin-gated at the
//    DB (P1) — WITHOUT locking out a legitimate admin (no regression).
// ===========================================================================
describeIntegration("Toolbox Talks · post-audit authz + evidence integrity (real member JWT, 20261030)", () => {
  let orgA = "";
  let staffId = "";
  let staffTok = "";
  let adminId = "";
  let adminTok = "";
  let refSeq = 8100;
  const svc = () => db(serviceClient());
  const staff = () => db(userClient(staffTok));
  const admin = () => db(userClient(adminTok));

  async function mkMember(role: string, tag: string): Promise<{ id: string; token: string }> {
    const email = `${T}-${tag}@x.test`;
    const created = await serviceClient().auth.admin.createUser({ email, password: `Pw-${T}`, email_confirm: true });
    if (created.error) throw new Error(`createUser ${tag}: ${created.error.message}`);
    const id = created.data.user?.id ?? "";
    const u = await svc().from("users").insert({ id, email, full_name: `${role} member` });
    if (u.error) throw new Error(`users ${tag}: ${u.error.message}`);
    const m = await svc().from("memberships").insert({ org_id: orgA, user_id: id, role });
    if (m.error) throw new Error(`membership ${tag}: ${m.error.message}`);
    const signIn = await anonClient().auth.signInWithPassword({ email, password: `Pw-${T}` });
    if (signIn.error) throw new Error(`signIn ${tag}: ${signIn.error.message}`);
    return { id, token: signIn.data.session?.access_token ?? "" };
  }

  // Seed a fresh ISSUED rev-1 talk in its own series (service role = trusted, exempt from
  // the JWT gates, so it can stamp the delivered state directly for the test's precondition).
  async function seedIssued(): Promise<{ id: string; ref: string }> {
    const ref = `TBT-${refSeq++}`;
    const d = await svc().from("toolbox_talks").insert({ org_id: orgA, topic: "Working at height", key_points: "Edge protection" }).select("id").single();
    if (d.error) throw new Error(`seed draft: ${d.error.message}`);
    const id = String(d.data?.id);
    const iss = await svc().from("toolbox_talks").update({ status: "issued", reference: ref, issued_at: new Date().toISOString() }).eq("id", id);
    if (iss.error) throw new Error(`seed issue: ${iss.error.message}`);
    return { id, ref };
  }

  beforeAll(async () => {
    orgA = String((await svc().from("organizations").insert({ name: "TBT-AZ", slug: `${T}-az` }).select("id").single()).data?.id ?? "");
    if (!orgA) throw new Error("authz fixture: org insert failed");
    ({ id: staffId, token: staffTok } = await mkMember("staff", "az-staff"));
    ({ id: adminId, token: adminTok } = await mkMember("admin", "az-admin"));
    if (!staffTok || !adminTok) throw new Error("authz fixture: member tokens missing");
    // Sanity: both memberships must resolve (else every gate below is vacuous).
    const s = await staff().rpc("next_tbt_number", { target_org: orgA });
    if (s.error) throw new Error(`staff membership not effective: ${s.error.message}`);
  });

  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (staffId) await serviceClient().auth.admin.deleteUser(staffId);
    if (adminId) await serviceClient().auth.admin.deleteUser(adminId);
  });

  it("[P0] a member cannot jump their own DRAFT straight to superseded/withdrawn (bypassing the issue gate)", async () => {
    for (const to of ["superseded", "withdrawn"] as const) {
      const d = await staff().from("toolbox_talks").insert({ org_id: orgA, topic: "Forge", key_points: "k" }).select("id").single();
      expect(d.error, d.error?.message).toBeNull();
      const id = String(d.data?.id);
      // A single crafted PATCH that would otherwise mint backdated, misattributed, PDF-renderable evidence.
      const r = await staff().from("toolbox_talks")
        .update({ status: to, reference: `${T}-forge-${to}`, issued_at: "2020-01-01T00:00:00Z", issued_by: staffId, snapshot: { talk_reference: "x", revision: 1, topic: "Forge", key_points: "k" } })
        .eq("id", id);
      expect(r.error?.message ?? "", `draft->${to} must be refused`).toMatch(/can only be delivered \(issued\)/i);
      await svc().from("toolbox_talks").delete().eq("id", id);
    }
  });

  it("[P1] a member cannot deliver with a snapshot that disagrees with the record (forged reference / topic)", async () => {
    const mkDraft = async () => {
      const d = await staff().from("toolbox_talks").insert({ org_id: orgA, topic: "Real topic", key_points: "Real points" }).select("id").single();
      return String(d.data?.id);
    };
    const ref1 = String((await staff().rpc("next_tbt_number", { target_org: orgA })).data);
    // (a) snapshot.talk_reference != the issued reference
    const idA = await mkDraft();
    const bad1 = await staff().from("toolbox_talks")
      .update({ status: "issued", reference: ref1, snapshot: { talk_reference: "TBT-DIFFERENT", revision: 1, topic: "Real topic", key_points: "Real points" } }).eq("id", idA);
    expect(bad1.error?.message ?? "", "a mismatched snapshot reference must be refused").toMatch(/snapshot reference must equal/i);
    // (b) snapshot.topic != the row's topic (the PDF body would misrepresent the briefing)
    const ref2 = String((await staff().rpc("next_tbt_number", { target_org: orgA })).data);
    const idB = await mkDraft();
    const bad2 = await staff().from("toolbox_talks")
      .update({ status: "issued", reference: ref2, snapshot: { talk_reference: ref2, revision: 1, topic: "FORGED topic", key_points: "Real points" } }).eq("id", idB);
    expect(bad2.error?.message ?? "", "a snapshot whose content disagrees with the row must be refused").toMatch(/snapshot content must match/i);
    // (c) the honest, matching snapshot succeeds (no false positive)
    const ref3 = String((await staff().rpc("next_tbt_number", { target_org: orgA })).data);
    const idC = await mkDraft();
    const ok = await staff().from("toolbox_talks")
      .update({ status: "issued", reference: ref3, snapshot: { talk_reference: ref3, revision: 1, topic: "Real topic", key_points: "Real points" } }).eq("id", idC);
    expect(ok.error, "a faithful snapshot must be accepted").toBeNull();
    await svc().from("toolbox_talks").delete().eq("id", idA);
    await svc().from("toolbox_talks").delete().eq("id", idB);
  });

  it("[P2] a member cannot inject a non-allowlist key (cost/PII) into the frozen evidence snapshot", async () => {
    const ref = String((await staff().rpc("next_tbt_number", { target_org: orgA })).data);
    const d = await staff().from("toolbox_talks").insert({ org_id: orgA, topic: "T", key_points: "K" }).select("id").single();
    const id = String(d.data?.id);
    const r = await staff().from("toolbox_talks")
      .update({ status: "issued", reference: ref, snapshot: { talk_reference: ref, revision: 1, topic: "T", key_points: "K", day_rate: 350, injected_email: "x@y.test" } }).eq("id", id);
    expect(r.error?.message ?? "", "an unexpected snapshot field must be refused").toMatch(/unexpected field/i);
    await svc().from("toolbox_talks").delete().eq("id", id);
  });

  it("[P1] a non-admin member cannot WITHDRAW delivered evidence; an admin can (DB gate = app isManager, no owner/admin lock-out)", async () => {
    const a = await seedIssued();
    const staffTry = await staff().from("toolbox_talks").update({ status: "withdrawn" }).eq("id", a.id);
    expect(staffTry.error?.message ?? "", "a staff member must not withdraw live evidence").toMatch(/only an owner or admin/i);
    // still issued (the crafted write did nothing)
    expect((await svc().from("toolbox_talks").select("status").eq("id", a.id).maybeSingle()).data?.status).toBe("issued");
    // an admin performs the same terminal transition successfully
    const adminOk = await admin().from("toolbox_talks").update({ status: "withdrawn" }).eq("id", a.id);
    expect(adminOk.error, "an admin must be able to withdraw").toBeNull();
    expect((await svc().from("toolbox_talks").select("status").eq("id", a.id).maybeSingle()).data?.status).toBe("withdrawn");
  });

  it("[P1] a non-admin member cannot RAISE a revision (rev>=2 insert); an admin can", async () => {
    const s1 = await seedIssued();
    const rootRow = (await svc().from("toolbox_talks").select("root_toolbox_talk_id").eq("id", s1.id).maybeSingle()).data;
    const root = String(rootRow?.root_toolbox_talk_id);
    const staffTry = await staff().from("toolbox_talks")
      .insert({ org_id: orgA, topic: "Working at height", key_points: "revised", root_toolbox_talk_id: root, revision_number: 2, supersedes_id: s1.id }).select("id").single();
    expect(staffTry.error?.message ?? "", "a staff member must not raise a revision").toMatch(/only an owner or admin can raise/i);
    const adminOk = await admin().from("toolbox_talks")
      .insert({ org_id: orgA, topic: "Working at height", key_points: "revised", root_toolbox_talk_id: root, revision_number: 2, supersedes_id: s1.id }).select("id").single();
    expect(adminOk.error, "an admin must be able to raise a revision").toBeNull();
  });

  it("[P1] a non-admin member cannot ISSUE a revision via the RPC; an admin can (atomic supersede+promote)", async () => {
    const s = await seedIssued();
    const root = String((await svc().from("toolbox_talks").select("root_toolbox_talk_id").eq("id", s.id).maybeSingle()).data?.root_toolbox_talk_id);
    // admin sets up the rev-2 draft (raising a revision is itself admin-gated, proven above)
    const rev2 = String((await admin().from("toolbox_talks")
      .insert({ org_id: orgA, topic: "Working at height", key_points: "revised", root_toolbox_talk_id: root, revision_number: 2, supersedes_id: s.id }).select("id").single()).data?.id);
    const snap = { talk_reference: `${s.ref}-R02`, revision: 2, topic: "Working at height", key_points: "revised" };
    const staffTry = await staff().rpc("issue_toolbox_talk_revision", { p_id: rev2, p_snapshot: snap });
    expect(staffTry.error?.message ?? "", "a staff member must not issue a revision").toMatch(/only an owner or admin can issue/i);
    // still a draft (the RPC refused before mutating)
    expect((await svc().from("toolbox_talks").select("status").eq("id", rev2).maybeSingle()).data?.status).toBe("draft");
    // the admin issues it — supersede rev1 + promote rev2, one current
    const adminOk = await admin().rpc("issue_toolbox_talk_revision", { p_id: rev2, p_snapshot: snap });
    expect(adminOk.error, "an admin must be able to issue a revision").toBeNull();
    expect(String(adminOk.data)).toBe(`${s.ref}-R02`);
    const series = (await svc().from("toolbox_talks").select("id, status").eq("root_toolbox_talk_id", root)).data ?? [];
    expect(series.filter((r) => r.status === "issued").length, "exactly one current revision").toBe(1);
    expect(series.find((r) => r.id === s.id)?.status, "rev 1 superseded").toBe("superseded");
  });

  it("[P3] the primary key of a delivered talk is frozen (a crafted id update is refused)", async () => {
    const s = await seedIssued();
    const r = await svc().from("toolbox_talks").update({ id: "00000000-0000-4000-8000-0000000000ff" }).eq("id", s.id);
    // svc bypasses RLS but not the immutable trigger — id is now in the frozen tuple
    expect(r.error?.message ?? "", "the PK of delivered evidence must be immutable").toMatch(/immutable/i);
  });

  it("[P2] a crafted issue snapshot cannot forge provenance — the DB overwrites issued_on/issuer + strips fabricated links", async () => {
    const d = await staff().from("toolbox_talks").insert({ org_id: orgA, topic: "Real", key_points: "Real points" }).select("id").single();
    const id = String(d.data?.id);
    const ref = String((await staff().rpc("next_tbt_number", { target_org: orgA })).data);
    // no RAMS/permit linked on the row; the crafted snapshot claims backdated issue, a spoofed
    // issuer, and fabricated RAMS + permit control references.
    const crafted = {
      talk_reference: ref, revision: 1, topic: "Real", key_points: "Real points",
      issued_on: "2020-01-01", issued_by_name: "FORGED Safety Manager",
      rams_reference: "RA-9999", rams_revision: 7,
      permit_reference: "PTW-9999", permit_status_at_issue: "active",
    };
    const iss = await staff().from("toolbox_talks").update({ status: "issued", reference: ref, snapshot: crafted }).eq("id", id);
    expect(iss.error, "the issue succeeds; the DB corrects the snapshot").toBeNull();
    const snap = (await svc().from("toolbox_talks").select("snapshot").eq("id", id).maybeSingle()).data?.snapshot as Record<string, unknown>;
    expect(snap.issued_on, "backdated issued_on is overwritten to the real issue date").not.toBe("2020-01-01");
    expect(snap.issued_by_name, "spoofed issuer name is overwritten (not the forged value)").not.toBe("FORGED Safety Manager");
    expect(snap.rams_reference, "fabricated RAMS reference stripped (no RAMS linked)").toBeNull();
    expect(snap.rams_revision, "fabricated RAMS revision stripped").toBeNull();
    expect(snap.permit_reference, "fabricated permit reference stripped (no permit linked)").toBeNull();
    expect(snap.permit_status_at_issue, "fabricated permit status stripped").toBeNull();
  });
});
