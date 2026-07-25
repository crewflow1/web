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
      .update({ status: "issued", reference: ref, issued_at: BACKDATE, issued_by: FORGED_USER, snapshot: { talk_reference: ref, revision: 1 } }).eq("id", id);
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
