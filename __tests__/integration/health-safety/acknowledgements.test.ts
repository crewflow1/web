import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Operative sign-off DB-invariant proofs (H&S M3, 20261020). Enforced for EVERY
 * caller incl. service_role: version-anchoring, live-document-only, membership,
 * cross-org rejection, append-only immutability, and per-operative-per-version
 * uniqueness. (Impersonation — sign-as-another-worker — is an RLS concern proven
 * in ../rls/health-safety-signoff-isolation.test.ts.)
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel }
interface Upd extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Upd }
interface Del extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Del }
interface Table {
  select(c?: string): Sel;
  insert(r: Row | Row[]): PromiseLike<Res<null>> & { select(c?: string): { single(): PromiseLike<Res<Row>> } };
  update(patch: Row): Upd;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const TOKEN = `it-ack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("Operative sign-off · DB invariants", () => {
  let orgA = "", orgB = "", memberA = "", nonMember = "", raIssued = "", raDraft = "", raBIssued = "";
  const REF_A = `RA-${TOKEN}-A`;
  const REF_B = `RA-${TOKEN}-B`;

  async function mkUser(label: string): Promise<string> {
    const u = await serviceClient().auth.admin.createUser({ email: `${TOKEN}-${label}@x.test`, password: `Pw-${TOKEN}`, email_confirm: true });
    const id = u.data.user?.id ?? "";
    await db(serviceClient()).from("users").insert({ id, email: `${TOKEN}-${label}@x.test`, full_name: `U ${label}` });
    return id;
  }

  beforeAll(async () => {
    const svc = db(serviceClient());
    orgA = String((await svc.from("organizations").insert({ name: "Ack A", slug: `${TOKEN}-a` }).select("id").single()).data?.id);
    orgB = String((await svc.from("organizations").insert({ name: "Ack B", slug: `${TOKEN}-b` }).select("id").single()).data?.id);
    memberA = await mkUser("m"); nonMember = await mkUser("n");
    await svc.from("memberships").insert({ org_id: orgA, user_id: memberA, role: "staff" });
    // an ISSUED RAMS in org A
    raIssued = String((await svc.from("risk_assessments").insert({ org_id: orgA, title: "RA issued", activity: "x" }).select("id").single()).data?.id);
    await svc.from("risk_assessments").update({ status: "issued", reference: REF_A, issued_at: new Date().toISOString() }).eq("id", raIssued);
    // a DRAFT RAMS in org A
    raDraft = String((await svc.from("risk_assessments").insert({ org_id: orgA, title: "RA draft", activity: "x" }).select("id").single()).data?.id);
    // an ISSUED RAMS in org B
    raBIssued = String((await svc.from("risk_assessments").insert({ org_id: orgB, title: "RA B", activity: "x" }).select("id").single()).data?.id);
    await svc.from("risk_assessments").update({ status: "issued", reference: REF_B, issued_at: new Date().toISOString() }).eq("id", raBIssued);
  });
  afterAll(async () => {
    if (orgA) await db(serviceClient()).from("organizations").delete().eq("id", orgA);
    if (orgB) await db(serviceClient()).from("organizations").delete().eq("id", orgB);
    for (const u of [memberA, nonMember]) if (u) await serviceClient().auth.admin.deleteUser(u);
  });

  const ack = (over: Row = {}) => db(serviceClient()).from("safety_acknowledgements").insert({
    org_id: orgA, subject_type: "risk_assessment", subject_id: raIssued, subject_version: REF_A,
    user_id: memberA, statement: "I confirm…", statement_version: "v1", signed_name: "U M", ...over,
  });

  it("a member can acknowledge an issued RAMS at its current version", async () => {
    const { error } = await ack();
    expect(error, error?.message).toBeNull();
  });
  it("is idempotent-unique per operative + version (duplicate rejected 23505)", async () => {
    const { error } = await ack();
    expect(error?.code, "duplicate must violate the unique constraint").toBe("23505");
  });
  it("rejects a version that isn't the issued reference (anchor)", async () => {
    const { error } = await ack({ user_id: memberA, subject_version: "RA-WRONG" });
    expect(error, "version mismatch must be rejected").not.toBeNull();
    expect(error?.code).not.toBe("23505");
  });
  it("rejects acknowledging a DRAFT document", async () => {
    const { error } = await ack({ subject_id: raDraft, subject_version: REF_A });
    expect(error, "cannot acknowledge a draft").not.toBeNull();
  });
  it("rejects acknowledging another org's document", async () => {
    const { error } = await ack({ subject_id: raBIssued, subject_version: REF_B });
    // memberA is not a member of org B → membership check (or org mismatch) rejects
    expect(error, "cross-org acknowledgement must be rejected").not.toBeNull();
  });
  it("rejects a non-member signer", async () => {
    const { error } = await ack({ user_id: nonMember });
    expect(error, "a non-member cannot sign").not.toBeNull();
  });
  it("is append-only — an acknowledgement cannot be edited", async () => {
    const svc = db(serviceClient());
    const row = await svc.from("safety_acknowledgements").select("id").eq("subject_id", raIssued).eq("user_id", memberA);
    const id = String((row.data ?? [])[0]?.id);
    const upd = await svc.from("safety_acknowledgements").update({ signed_name: "TAMPERED", acknowledged_at: new Date().toISOString() }).eq("id", id);
    expect(upd.error, "an acknowledgement must be immutable").not.toBeNull();
  });

  // --- adversarial-review regression tests ---

  it("[backdating] the signing timestamp is pinned server-side (client value ignored)", async () => {
    const svc = db(serviceClient());
    // second member so we don't hit the unique constraint from earlier tests
    const u2 = await mkUser("b2");
    await svc.from("memberships").insert({ org_id: orgA, user_id: u2, role: "staff" });
    const ins = await svc.from("safety_acknowledgements")
      .insert({ org_id: orgA, subject_type: "risk_assessment", subject_id: raIssued, subject_version: REF_A, user_id: u2, statement: "x", statement_version: "v1", signed_name: "U b2", acknowledged_at: "2020-01-01T00:00:00Z" })
      .select("acknowledged_at").single();
    expect(ins.error, ins.error?.message).toBeNull();
    // the stored time is NOW, not the 2020 value the client supplied
    expect(new Date(String(ins.data?.acknowledged_at)).getFullYear()).toBeGreaterThan(2024);
    await serviceClient().auth.admin.deleteUser(u2);
  });

  it("[expired-permit] a permit outside its validity window cannot be acknowledged", async () => {
    const svc = db(serviceClient());
    const p = await svc.from("permits_to_work")
      .insert({ org_id: orgA, permit_type: "general", title: "old", scope: "x",
        valid_from: "2020-01-01T00:00:00Z", valid_until: "2020-01-02T00:00:00Z" })
      .select("id").single();
    const pid = String(p.data?.id);
    const ref = `PTW-${TOKEN}-exp`;
    await svc.from("permits_to_work").update({ status: "issued", reference: ref, issued_at: new Date().toISOString() }).eq("id", pid);
    const { error } = await svc.from("safety_acknowledgements")
      .insert({ org_id: orgA, subject_type: "permit_to_work", subject_id: pid, subject_version: ref, user_id: memberA, statement: "x", statement_version: "v1", signed_name: "U M" });
    expect(error, "acknowledging an expired permit must be rejected").not.toBeNull();
  });
});
