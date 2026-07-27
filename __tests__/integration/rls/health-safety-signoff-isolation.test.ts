import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * RLS proof — safety_acknowledgements (H&S M3, 20261020). Tenant-private; a worker
 * may record an acknowledgement ONLY as themselves (`user_id = auth.uid()`) — no
 * signing on another operative's behalf — and only in their own org.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel }
interface Ins extends PromiseLike<Res<Row[]>> { select(c?: string): { single(): PromiseLike<Res<Row>> } }
interface Del extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Del }
interface Upd extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Upd }
interface Table { select(c?: string): Sel; insert(r: Row | Row[]): Ins; delete(): Del; update(patch: Row): Upd }
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const TOKEN = `it-ack-rls-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("safety_acknowledgements · sign-as-self + tenant isolation (RLS)", () => {
  let orgId = "", raId = "", memberId = "", memberToken = "", otherId = "", ackId = "";
  const REF = `RA-${TOKEN}`;

  async function mkUser(label: string): Promise<string> {
    const u = await serviceClient().auth.admin.createUser({ email: `${TOKEN}-${label}@x.test`, password: `Pw-${TOKEN}`, email_confirm: true });
    const id = u.data.user?.id ?? "";
    await db(serviceClient()).from("users").insert({ id, email: `${TOKEN}-${label}@x.test`, full_name: `U ${label}` });
    return id;
  }

  beforeAll(async () => {
    const svc = db(serviceClient());
    orgId = String((await svc.from("organizations").insert({ name: "Ack RLS", slug: TOKEN }).select("id").single()).data?.id);
    memberId = await mkUser("m"); otherId = await mkUser("o");
    await svc.from("memberships").insert([{ org_id: orgId, user_id: memberId, role: "staff" }, { org_id: orgId, user_id: otherId, role: "staff" }]);
    raId = String((await svc.from("risk_assessments").insert({ org_id: orgId, title: "RA", activity: "x" }).select("id").single()).data?.id);
    await svc.from("risk_assessments").update({ status: "issued", reference: REF, issued_at: new Date().toISOString() }).eq("id", raId);
    // one acknowledgement (by service role) so the read tests have a row
    ackId = String((await svc.from("safety_acknowledgements").insert({ org_id: orgId, subject_type: "risk_assessment", subject_id: raId, subject_version: REF, user_id: otherId, statement: "x", statement_version: "v1", signed_name: "U o" }).select("id").single()).data?.id);
    memberToken = (await anonClient().auth.signInWithPassword({ email: `${TOKEN}-m@x.test`, password: `Pw-${TOKEN}` })).data.session?.access_token ?? "";
    if (!memberToken) throw new Error("failed to mint member token");
  });
  afterAll(async () => {
    if (orgId) await db(serviceClient()).from("organizations").delete().eq("id", orgId);
    for (const u of [memberId, otherId]) if (u) await serviceClient().auth.admin.deleteUser(u);
  });

  it("anon cannot read acknowledgements (RLS enforced)", async () => {
    expect((await db(anonClient()).from("safety_acknowledgements").select("id").eq("id", ackId)).data ?? []).toHaveLength(0);
  });
  it("a member CAN sign as themselves on an issued doc", async () => {
    const { error } = await db(userClient(memberToken)).from("safety_acknowledgements")
      .insert({ org_id: orgId, subject_type: "risk_assessment", subject_id: raId, subject_version: REF, user_id: memberId, statement: "x", statement_version: "v1", signed_name: "U m" });
    expect(error, error?.message).toBeNull();
  });
  it("a member CANNOT sign as ANOTHER worker (user_id != auth.uid — impersonation blocked)", async () => {
    const { error } = await db(userClient(memberToken)).from("safety_acknowledgements")
      .insert({ org_id: orgId, subject_type: "risk_assessment", subject_id: raId, subject_version: REF, user_id: otherId, statement: "x", statement_version: "v1", signed_name: "spoof" });
    expect(error, "signing as another user must be refused by RLS").not.toBeNull();
  });

  it("an authenticated member cannot DELETE an acknowledgement (non-erasable evidence)", async () => {
    // no DELETE policy → RLS turns it into a no-op (0 rows), the row survives
    await db(userClient(memberToken)).from("safety_acknowledgements").delete().eq("id", ackId);
    const still = await db(serviceClient()).from("safety_acknowledgements").select("id").eq("id", ackId);
    expect(still.data ?? [], "the acknowledgement must survive a delete attempt").toHaveLength(1);
  });
});
