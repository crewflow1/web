import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * RLS proof — RAMS (risk_assessments + risk_assessment_hazards) are tenant-private
 * (Health & Safety, 20261018000000). Every policy is scoped to
 * `org_id in (select current_org_ids())`. This converts that intent into a runtime
 * check against real Postgres with the migrations applied: service_role (BYPASSRLS)
 * sees the row it created; anon does not (RLS on); an AUTHENTICATED non-member does
 * not (the gate is org MEMBERSHIP, not mere authentication — the property a
 * cross-tenant leak would violate). Serial integration config; org cascades on teardown.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel }
interface Ins extends PromiseLike<Res<Row[]>> { select(c?: string): { single(): PromiseLike<Res<Row>> } }
interface Del extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Del }
interface Table { select(c?: string): Sel; insert(r: Row | Row[]): Ins; delete(): Del }
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-hs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("risk_assessments · tenant isolation (RLS)", () => {
  let orgId = "";
  let raId = "";
  let hazardId = "";
  let authUserId = "";
  let authToken = "";

  beforeAll(async () => {
    const svc = db(serviceClient());
    const org = await svc.from("organizations").insert({ name: "RAMS RLS Probe", slug: TOKEN }).select("id").single();
    expect(org.error, org.error?.message).toBeNull();
    orgId = String(org.data?.id ?? "");

    const ra = await svc.from("risk_assessments")
      .insert({ org_id: orgId, title: "RLS probe RA", activity: "Probe" }).select("id").single();
    expect(ra.error, ra.error?.message).toBeNull();
    raId = String(ra.data?.id ?? "");

    const hz = await svc.from("risk_assessment_hazards")
      .insert({ org_id: orgId, risk_assessment_id: raId, hazard: "Probe hazard", likelihood: 2, severity: 2, control_measures: "x" })
      .select("id").single();
    expect(hz.error, hz.error?.message).toBeNull();
    hazardId = String(hz.data?.id ?? "");

    const email = `${TOKEN}@example.test`;
    const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
    expect(created.error, created.error?.message).toBeNull();
    authUserId = created.data.user?.id ?? "";
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    expect(signedIn.error, signedIn.error?.message).toBeNull();
    authToken = signedIn.data.session?.access_token ?? "";
    if (!authToken) throw new Error("failed to mint an authenticated token");
  });

  afterAll(async () => {
    if (orgId) await db(serviceClient()).from("organizations").delete().eq("id", orgId);
    if (authUserId) await serviceClient().auth.admin.deleteUser(authUserId);
  });

  it("service_role can read the RA + hazard it created (RLS bypassed)", async () => {
    const ra = await db(serviceClient()).from("risk_assessments").select("id, title").eq("id", raId);
    expect(ra.error, ra.error?.message).toBeNull();
    expect(ra.data ?? []).toHaveLength(1);
    const hz = await db(serviceClient()).from("risk_assessment_hazards").select("id").eq("id", hazardId);
    expect(hz.data ?? []).toHaveLength(1);
  });

  it("anon cannot see the RA (RLS enforced)", async () => {
    const { data } = await db(anonClient()).from("risk_assessments").select("id").eq("id", raId);
    expect(data ?? []).toHaveLength(0);
  });

  it("anon cannot see the hazard (RLS enforced)", async () => {
    const { data } = await db(anonClient()).from("risk_assessment_hazards").select("id").eq("id", hazardId);
    expect(data ?? []).toHaveLength(0);
  });

  it("an authenticated NON-member cannot see the RA (membership-gated)", async () => {
    const { data } = await db(userClient(authToken)).from("risk_assessments").select("id").eq("id", raId);
    expect(data ?? []).toHaveLength(0);
  });

  it("an authenticated NON-member cannot see the hazard (membership-gated)", async () => {
    const { data } = await db(userClient(authToken)).from("risk_assessment_hazards").select("id").eq("id", hazardId);
    expect(data ?? []).toHaveLength(0);
  });

  it("an authenticated NON-member cannot insert a hazard into the org's RA (write-gated)", async () => {
    // Even though the org_id is trigger-derived from the parent, the RLS with-check
    // (org membership) must still refuse a non-member's write.
    const { error } = await db(userClient(authToken)).from("risk_assessment_hazards")
      .insert({ org_id: orgId, risk_assessment_id: raId, hazard: "intruder", likelihood: 1, severity: 1, control_measures: "x" });
    expect(error, "a non-member insert must be refused").not.toBeNull();
  });
});
