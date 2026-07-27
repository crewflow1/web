import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Toolbox Talk acknowledgement DB-invariants (M2, 20261026). Proves the SHARED
 * safety_acknowledgements engine now accepts subject_type='toolbox_talk' and gates
 * it correctly for EVERY caller (incl. service_role): only an ISSUED (current) talk
 * is acknowledgeable — a draft, superseded or withdrawn talk is not — version is
 * anchored to the TBT reference, cross-org is rejected, and the record is
 * per-operative-per-version unique + append-only. Mirrors acknowledgements.test.ts.
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
const TOKEN = `it-ttack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("Toolbox Talk acknowledgement · DB invariants (20261026)", () => {
  let orgA = "", orgB = "", memberA = "", nonMember = "";
  let ttIssued = "", ttDraft = "", ttWithdrawn = "", ttBIssued = "";
  const REF_A = `TBT-${TOKEN}-A`;
  const REF_W = `TBT-${TOKEN}-W`;
  const REF_B = `TBT-${TOKEN}-B`;
  const svc = () => db(serviceClient());

  async function mkUser(label: string): Promise<string> {
    const u = await serviceClient().auth.admin.createUser({ email: `${TOKEN}-${label}@x.test`, password: `Pw-${TOKEN}`, email_confirm: true });
    const id = u.data.user?.id ?? "";
    await svc().from("users").insert({ id, email: `${TOKEN}-${label}@x.test`, full_name: `U ${label}` });
    return id;
  }

  // Create a talk and drive it to a target status (draft->issued[->terminal]).
  async function mkTalk(org: string, ref: string | null, target: "draft" | "issued" | "withdrawn"): Promise<string> {
    const id = String((await svc().from("toolbox_talks")
      .insert({ org_id: org, topic: "Working at height", key_points: "Edge protection + harness" })
      .select("id").single()).data?.id);
    if (target === "draft") return id;
    await svc().from("toolbox_talks").update({ status: "issued", reference: ref, issued_at: new Date().toISOString() }).eq("id", id);
    if (target === "withdrawn") await svc().from("toolbox_talks").update({ status: "withdrawn" }).eq("id", id);
    return id;
  }

  beforeAll(async () => {
    orgA = String((await svc().from("organizations").insert({ name: "TT-Ack A", slug: `${TOKEN}-a` }).select("id").single()).data?.id);
    orgB = String((await svc().from("organizations").insert({ name: "TT-Ack B", slug: `${TOKEN}-b` }).select("id").single()).data?.id);
    memberA = await mkUser("m"); nonMember = await mkUser("n");
    await svc().from("memberships").insert({ org_id: orgA, user_id: memberA, role: "staff" });
    ttIssued = await mkTalk(orgA, REF_A, "issued");
    ttDraft = await mkTalk(orgA, null, "draft");
    ttWithdrawn = await mkTalk(orgA, REF_W, "withdrawn");
    ttBIssued = await mkTalk(orgB, REF_B, "issued");
  });
  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (orgB) await svc().from("organizations").delete().eq("id", orgB);
    for (const u of [memberA, nonMember]) if (u) await serviceClient().auth.admin.deleteUser(u);
  });

  const ack = (over: Row = {}) => svc().from("safety_acknowledgements").insert({
    org_id: orgA, subject_type: "toolbox_talk", subject_id: ttIssued, subject_version: REF_A,
    user_id: memberA, statement: "I attended…", statement_version: "v1", signed_name: "U M", ...over,
  });

  it("a member can acknowledge an issued toolbox talk at its current version", async () => {
    const { error } = await ack();
    expect(error, error?.message).toBeNull();
  });
  it("is idempotent-unique per operative + version (duplicate rejected 23505)", async () => {
    const { error } = await ack();
    expect(error?.code, "duplicate must violate the unique constraint").toBe("23505");
  });
  it("rejects a version that isn't the issued reference (anchor)", async () => {
    const { error } = await ack({ subject_version: "TBT-WRONG" });
    expect(error, "version mismatch must be rejected").not.toBeNull();
    expect(error?.code).not.toBe("23505");
  });
  it("rejects acknowledging a DRAFT talk (not yet delivered)", async () => {
    const { error } = await ack({ subject_id: ttDraft, subject_version: REF_A });
    expect(error?.message ?? "", "a draft talk cannot be acknowledged").toMatch(/cannot acknowledge a draft toolbox talk/i);
  });
  it("rejects acknowledging a WITHDRAWN talk (historical, not current)", async () => {
    const { error } = await ack({ subject_id: ttWithdrawn, subject_version: REF_W });
    expect(error?.message ?? "", "a withdrawn talk cannot be acknowledged").toMatch(/cannot acknowledge a withdrawn toolbox talk/i);
  });
  it("rejects acknowledging another org's talk", async () => {
    const { error } = await ack({ subject_id: ttBIssued, subject_version: REF_B });
    expect(error, "cross-org acknowledgement must be rejected").not.toBeNull();
  });
  it("rejects a non-member signer", async () => {
    const { error } = await ack({ user_id: nonMember });
    expect(error, "a non-member cannot sign").not.toBeNull();
  });
  it("derives org_id from the subject (a spoofed org_id can't cross tenants)", async () => {
    const u2 = await mkUser("s");
    await svc().from("memberships").insert({ org_id: orgA, user_id: u2, role: "staff" });
    // claim org B, but the subject is an org-A talk → trigger overwrites org_id to A and succeeds
    const ins = await svc().from("safety_acknowledgements")
      .insert({ org_id: orgB, subject_type: "toolbox_talk", subject_id: ttIssued, subject_version: REF_A, user_id: u2, statement: "x", statement_version: "v1", signed_name: "U s" })
      .select("org_id").single();
    expect(ins.error, ins.error?.message).toBeNull();
    expect(ins.data?.org_id, "org_id must be re-derived from the subject").toBe(orgA);
    await serviceClient().auth.admin.deleteUser(u2);
  });
  it("is append-only — a toolbox-talk acknowledgement cannot be edited", async () => {
    const row = await svc().from("safety_acknowledgements").select("id").eq("subject_id", ttIssued).eq("user_id", memberA);
    const id = String((row.data ?? [])[0]?.id);
    const upd = await svc().from("safety_acknowledgements").update({ signed_name: "TAMPERED" }).eq("id", id);
    expect(upd.error, "an acknowledgement must be immutable").not.toBeNull();
  });
  it("[backdating] the signing timestamp is pinned server-side (client value ignored)", async () => {
    const u3 = await mkUser("b3");
    await svc().from("memberships").insert({ org_id: orgA, user_id: u3, role: "staff" });
    const ins = await svc().from("safety_acknowledgements")
      .insert({ org_id: orgA, subject_type: "toolbox_talk", subject_id: ttIssued, subject_version: REF_A, user_id: u3, statement: "x", statement_version: "v1", signed_name: "U b3", acknowledged_at: "2020-01-01T00:00:00Z" })
      .select("acknowledged_at").single();
    expect(ins.error, ins.error?.message).toBeNull();
    expect(new Date(String(ins.data?.acknowledged_at)).getFullYear()).toBeGreaterThan(2024);
    await serviceClient().auth.admin.deleteUser(u3);
  });
});
