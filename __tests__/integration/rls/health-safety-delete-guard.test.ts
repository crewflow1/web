import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * RLS proof — issued H&S evidence is NON-DELETABLE (M5, 20261021). An org admin may
 * delete a DRAFT RAMS/permit, but an ISSUED one is evidence and its delete policy is
 * gated to draft-only. Verified with a real admin (owner) token — RLS turns the
 * forbidden delete into a no-op (the row survives). Immutability triggers separately
 * prevent flipping an issued record back to draft to sneak a delete.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel }
interface Ins extends PromiseLike<Res<Row[]>> { select(c?: string): { single(): PromiseLike<Res<Row>> } }
interface Del extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Del }
interface Upd extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Upd }
interface Table { select(c?: string): Sel; insert(r: Row | Row[]): Ins; delete(): Del; update(p: Row): Upd }
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const TOKEN = `it-del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("H&S evidence · issued records are non-deletable (RLS delete-guard)", () => {
  let orgId = "", ownerId = "", ownerToken = "", raIssued = "", raDraft = "", pIssued = "", pDraft = "";

  beforeAll(async () => {
    const svc = db(serviceClient());
    orgId = String((await svc.from("organizations").insert({ name: "Del Guard", slug: TOKEN }).select("id").single()).data?.id);
    const created = await serviceClient().auth.admin.createUser({ email: `${TOKEN}@x.test`, password: `Pw-${TOKEN}`, email_confirm: true });
    ownerId = created.data.user?.id ?? "";
    await svc.from("users").insert({ id: ownerId, email: `${TOKEN}@x.test`, full_name: "Owner" });
    await svc.from("memberships").insert({ org_id: orgId, user_id: ownerId, role: "owner" });
    // issued + draft RAMS
    raIssued = String((await svc.from("risk_assessments").insert({ org_id: orgId, title: "issued", activity: "x" }).select("id").single()).data?.id);
    await svc.from("risk_assessments").update({ status: "issued", reference: `RA-${TOKEN}`, issued_at: new Date().toISOString() }).eq("id", raIssued);
    raDraft = String((await svc.from("risk_assessments").insert({ org_id: orgId, title: "draft", activity: "x" }).select("id").single()).data?.id);
    // issued + draft permit
    pIssued = String((await svc.from("permits_to_work").insert({ org_id: orgId, permit_type: "general", title: "p", scope: "s", valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 3.6e6).toISOString() }).select("id").single()).data?.id);
    await svc.from("permits_to_work").update({ status: "issued", reference: `PTW-${TOKEN}`, issued_at: new Date().toISOString() }).eq("id", pIssued);
    pDraft = String((await svc.from("permits_to_work").insert({ org_id: orgId, permit_type: "general", title: "pd", scope: "s" }).select("id").single()).data?.id);
    ownerToken = (await anonClient().auth.signInWithPassword({ email: `${TOKEN}@x.test`, password: `Pw-${TOKEN}` })).data.session?.access_token ?? "";
    if (!ownerToken) throw new Error("no owner token");
  });
  afterAll(async () => {
    if (orgId) await db(serviceClient()).from("organizations").delete().eq("id", orgId);
    if (ownerId) await serviceClient().auth.admin.deleteUser(ownerId);
  });

  const survives = async (table: string, id: string) =>
    ((await db(serviceClient()).from(table).select("id").eq("id", id)).data ?? []).length === 1;

  it("an admin CANNOT delete an issued RAMS (evidence survives)", async () => {
    await db(userClient(ownerToken)).from("risk_assessments").delete().eq("id", raIssued);
    expect(await survives("risk_assessments", raIssued)).toBe(true);
  });
  it("an admin CAN delete a DRAFT RAMS", async () => {
    await db(userClient(ownerToken)).from("risk_assessments").delete().eq("id", raDraft);
    expect(await survives("risk_assessments", raDraft)).toBe(false);
  });
  it("an admin CANNOT delete an issued permit (evidence survives)", async () => {
    await db(userClient(ownerToken)).from("permits_to_work").delete().eq("id", pIssued);
    expect(await survives("permits_to_work", pIssued)).toBe(true);
  });
  it("an admin CAN delete a DRAFT permit", async () => {
    await db(userClient(ownerToken)).from("permits_to_work").delete().eq("id", pDraft);
    expect(await survives("permits_to_work", pDraft)).toBe(false);
  });
  it("an issued RAMS cannot be flipped back to draft (no delete-guard bypass)", async () => {
    const { error } = await db(serviceClient()).from("risk_assessments").update({ status: "draft" }).eq("id", raIssued);
    expect(error, "issued->draft must be blocked by the immutability trigger").not.toBeNull();
  });

  // M5 final review (P1): the guard is a TRIGGER, so it holds for the SERVICE ROLE
  // too (which bypasses RLS) — unlike a delete policy. Evidence is role-independent.
  it("even the service role cannot delete an issued RAMS (trigger, not just RLS)", async () => {
    const { error } = await db(serviceClient()).from("risk_assessments").delete().eq("id", raIssued);
    expect(error, "the BEFORE DELETE trigger must raise for the service role").not.toBeNull();
    expect(await survives("risk_assessments", raIssued)).toBe(true);
  });
  it("even the service role cannot delete an issued permit (trigger, not just RLS)", async () => {
    const { error } = await db(serviceClient()).from("permits_to_work").delete().eq("id", pIssued);
    expect(error, "the BEFORE DELETE trigger must raise for the service role").not.toBeNull();
    expect(await survives("permits_to_work", pIssued)).toBe(true);
  });

  // The guard must NOT break org teardown: an org holding issued evidence still
  // deletes cleanly (the cascade removes the org first, so the trigger allows it).
  it("tearing down an org cascades even when it holds issued RAMS + permits", async () => {
    const svc = db(serviceClient());
    const tearToken = `${TOKEN}-tear`;
    const oid = String((await svc.from("organizations").insert({ name: "Teardown", slug: tearToken }).select("id").single()).data?.id);
    const ra = String((await svc.from("risk_assessments").insert({ org_id: oid, title: "t", activity: "x" }).select("id").single()).data?.id);
    await svc.from("risk_assessments").update({ status: "issued", reference: `RA-${tearToken}`, issued_at: new Date().toISOString() }).eq("id", ra);
    const p = String((await svc.from("permits_to_work").insert({ org_id: oid, permit_type: "general", title: "t", scope: "s", valid_from: new Date().toISOString(), valid_until: new Date(Date.now() + 3.6e6).toISOString() }).select("id").single()).data?.id);
    await svc.from("permits_to_work").update({ status: "issued", reference: `PTW-${tearToken}`, issued_at: new Date().toISOString() }).eq("id", p);

    const { error } = await svc.from("organizations").delete().eq("id", oid);
    expect(error, "org teardown must not be blocked by the evidence delete-guard").toBeNull();
    expect(await survives("risk_assessments", ra), "the issued RAMS should be gone with its org").toBe(false);
  });
});
