import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * Health & Safety — issue-path hardening proved against a REAL authenticated
 * member (JWT), the actual attack surface (the browser ships the anon key; a
 * server action is not a boundary). These prove the final-review P0/P1/P2 fixes
 * fire for a real caller, not only the trusted service role:
 *
 *   P0  a member cannot INSERT an already-`issued` RAMS (born-a-draft guard).
 *   P0  a member cannot issue a RAMS with no assessor / no hazard (DB issue-gate).
 *   P1  on issue, issued_by / issued_at are pinned to the caller / now — a forged
 *       issuer or back-dated issue instant is ignored (RAMS *and* permit).
 *   P2  next_ra_number refuses another org's number (no cross-org count oracle).
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel; maybeSingle(): PromiseLike<Res<Row>> }
interface Ins extends PromiseLike<Res<Row[]>> { select(c?: string): { single(): PromiseLike<Res<Row>> } }
interface Upd extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Upd }
interface Del extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Del }
interface Table { select(c?: string): Sel; insert(r: Row | Row[]): Ins; update(p: Row): Upd; delete(): Del }
const db = (client: unknown) => client as unknown as {
  from(t: string): Table;
  rpc(fn: string, args: Row): PromiseLike<Res<unknown>>;
};
const TOKEN = `it-issh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const FORGED_USER = "00000000-0000-4000-8000-000000000abc"; // a plausible-but-not-ours uuid
const BACKDATE = "2020-01-01T00:00:00Z";

describeIntegration("H&S issue-path hardening · real authenticated member (JWT)", () => {
  let orgA = "", orgB = "", uid = "", token = "";
  const svc = () => db(serviceClient());
  const me = () => db(userClient(token));

  beforeAll(async () => {
    const a = await svc().from("organizations").insert({ name: "Issue A", slug: `${TOKEN}-a` }).select("id").single();
    if (a.error) throw new Error(`org A insert: ${a.error.message}`);
    orgA = String(a.data?.id);
    const b = await svc().from("organizations").insert({ name: "Issue B", slug: `${TOKEN}-b` }).select("id").single();
    if (b.error) throw new Error(`org B insert: ${b.error.message}`);
    orgB = String(b.data?.id);
    const created = await serviceClient().auth.admin.createUser({ email: `${TOKEN}@x.test`, password: `Pw-${TOKEN}`, email_confirm: true });
    if (created.error) throw new Error(`createUser: ${created.error.message}`);
    uid = created.data.user?.id ?? "";
    const u = await svc().from("users").insert({ id: uid, email: `${TOKEN}@x.test`, full_name: "Member" });
    if (u.error) throw new Error(`users insert: ${u.error.message}`);
    // Plain (non-admin) staff member of A only — NOT of B (the cross-org oracle
    // target). "staff" is deliberate: it proves the DB gates fire for any member,
    // not just an admin.
    const m = await svc().from("memberships").insert({ org_id: orgA, user_id: uid, role: "staff" });
    if (m.error) throw new Error(`membership insert: ${m.error.message}`);
    const signIn = await anonClient().auth.signInWithPassword({ email: `${TOKEN}@x.test`, password: `Pw-${TOKEN}` });
    if (signIn.error) throw new Error(`signIn: ${signIn.error.message}`);
    token = signIn.data.session?.access_token ?? "";
    if (!token) throw new Error("no member token");
    // Sanity: the member must actually resolve to org A via current_org_ids().
    const check = await db(userClient(token)).rpc("next_ra_number", { target_org: orgA });
    if (check.error) throw new Error(`membership not effective (current_org_ids empty?): ${check.error.message}`);
  });
  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (orgB) await svc().from("organizations").delete().eq("id", orgB);
    if (uid) await serviceClient().auth.admin.deleteUser(uid);
  });

  // Create a draft RAMS as the member; optionally give it an assessor + a hazard.
  async function draftRa(opts: { assessor: boolean; hazard: boolean }): Promise<string> {
    const id = String((await me().from("risk_assessments")
      .insert({ org_id: orgA, title: "Drafted", activity: "x", assessor_id: opts.assessor ? uid : null })
      .select("id").single()).data?.id);
    if (opts.hazard) {
      await me().from("risk_assessment_hazards").insert({ org_id: orgA, risk_assessment_id: id, hazard: "Fall", likelihood: 3, severity: 3, control_measures: "harness" });
    }
    return id;
  }

  it("[P0] a member cannot INSERT an already-issued RAMS (born-a-draft guard)", async () => {
    const { error } = await me().from("risk_assessments").insert({
      org_id: orgA, title: "Forged", activity: "x", status: "issued",
      reference: `RA-${TOKEN}-forge`, issued_at: new Date().toISOString(), issued_by: uid,
    });
    expect(error, "a direct INSERT with status=issued must be rejected").not.toBeNull();
  });

  it("[P0] a member cannot issue a RAMS with no hazard (DB issue-gate)", async () => {
    const raId = await draftRa({ assessor: true, hazard: false });
    const { error } = await me().from("risk_assessments")
      .update({ status: "issued", reference: `RA-${TOKEN}-nohaz`, issued_at: new Date().toISOString() }).eq("id", raId);
    expect(error?.message ?? "", "issuing with zero hazards must fail").toMatch(/hazard/i);
  });

  it("[P0] a member cannot issue a RAMS with no assessor (DB issue-gate)", async () => {
    const raId = await draftRa({ assessor: false, hazard: true });
    const { error } = await me().from("risk_assessments")
      .update({ status: "issued", reference: `RA-${TOKEN}-noass`, issued_at: new Date().toISOString() }).eq("id", raId);
    expect(error?.message ?? "", "issuing with no assessor must fail").toMatch(/assessor/i);
  });

  it("[P1] issuing pins issued_by=caller and issued_at=now — a forged/back-dated issue is ignored", async () => {
    const raId = await draftRa({ assessor: true, hazard: true });
    const { error } = await me().from("risk_assessments")
      .update({ status: "issued", reference: `RA-${TOKEN}-ok`, issued_at: BACKDATE, issued_by: FORGED_USER })
      .eq("id", raId);
    expect(error, error?.message).toBeNull();
    const row = (await svc().from("risk_assessments").select("issued_by, issued_at, status").eq("id", raId).maybeSingle()).data;
    expect(row?.status).toBe("issued");
    expect(row?.issued_by, "issued_by must be pinned to the acting member, not the forged id").toBe(uid);
    expect(new Date(String(row?.issued_at)).getTime(), "issued_at must be pinned to now(), not back-dated")
      .toBeGreaterThan(Date.parse("2021-01-01T00:00:00Z"));
  });

  it("[P1] issuing a permit pins issued_by=caller and issued_at=now (forge/back-date ignored)", async () => {
    const pid = String((await me().from("permits_to_work").insert({
      org_id: orgA, permit_type: "general", title: "P", scope: "s",
      valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 3.6e6).toISOString(),
    }).select("id").single()).data?.id);
    const { error } = await me().from("permits_to_work")
      .update({ status: "issued", reference: `PTW-${TOKEN}`, issued_at: BACKDATE, issued_by: FORGED_USER })
      .eq("id", pid);
    expect(error, error?.message).toBeNull();
    const row = (await svc().from("permits_to_work").select("issued_by, issued_at").eq("id", pid).maybeSingle()).data;
    expect(row?.issued_by, "permit issued_by must be pinned to the acting member").toBe(uid);
    expect(new Date(String(row?.issued_at)).getTime(), "permit issued_at must be pinned to now()")
      .toBeGreaterThan(Date.parse("2021-01-01T00:00:00Z"));
  });

  it("[P2] next_ra_number refuses another org's number, but allows the caller's own", async () => {
    const foreign = await db(userClient(token)).rpc("next_ra_number", { target_org: orgB });
    expect(foreign.error, "probing another org's RAMS count must be forbidden").not.toBeNull();
    const own = await db(userClient(token)).rpc("next_ra_number", { target_org: orgA });
    expect(own.error, own.error?.message).toBeNull();
    expect(String(own.data)).toMatch(/^RA-\d{4}$/);
  });
});
