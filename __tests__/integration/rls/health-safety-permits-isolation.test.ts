import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * RLS proof — permits_to_work + permit_conditions are tenant-private (H&S M2,
 * 20261019). Every policy is scoped to `org_id in (select current_org_ids())`.
 * service_role sees its row; anon does not; an authenticated NON-member does not
 * (membership-gated) and cannot write.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel }
interface Ins extends PromiseLike<Res<Row[]>> { select(c?: string): { single(): PromiseLike<Res<Row>> } }
interface Del extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Del }
interface Table { select(c?: string): Sel; insert(r: Row | Row[]): Ins; delete(): Del }
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const TOKEN = `it-ptw-rls-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("permits_to_work · tenant isolation (RLS)", () => {
  let orgId = "", permitId = "", condId = "", authUserId = "", authToken = "";

  beforeAll(async () => {
    const svc = db(serviceClient());
    orgId = String((await svc.from("organizations").insert({ name: "PTW RLS", slug: TOKEN }).select("id").single()).data?.id);
    permitId = String((await svc.from("permits_to_work").insert({ org_id: orgId, permit_type: "general", title: "RLS permit", scope: "x" }).select("id").single()).data?.id);
    condId = String((await svc.from("permit_conditions").insert({ org_id: orgId, permit_id: permitId, label: "Probe", required: true }).select("id").single()).data?.id);

    const email = `${TOKEN}@example.test`, password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
    authUserId = (await serviceClient().auth.admin.createUser({ email, password, email_confirm: true })).data.user?.id ?? "";
    authToken = (await anonClient().auth.signInWithPassword({ email, password })).data.session?.access_token ?? "";
    if (!authToken) throw new Error("failed to mint token");
  });
  afterAll(async () => {
    if (orgId) await db(serviceClient()).from("organizations").delete().eq("id", orgId);
    if (authUserId) await serviceClient().auth.admin.deleteUser(authUserId);
  });

  it("service_role sees the permit + condition (RLS bypassed)", async () => {
    expect((await db(serviceClient()).from("permits_to_work").select("id").eq("id", permitId)).data ?? []).toHaveLength(1);
    expect((await db(serviceClient()).from("permit_conditions").select("id").eq("id", condId)).data ?? []).toHaveLength(1);
  });
  it("anon sees neither (RLS enforced)", async () => {
    expect((await db(anonClient()).from("permits_to_work").select("id").eq("id", permitId)).data ?? []).toHaveLength(0);
    expect((await db(anonClient()).from("permit_conditions").select("id").eq("id", condId)).data ?? []).toHaveLength(0);
  });
  it("an authenticated NON-member sees neither (membership-gated)", async () => {
    expect((await db(userClient(authToken)).from("permits_to_work").select("id").eq("id", permitId)).data ?? []).toHaveLength(0);
    expect((await db(userClient(authToken)).from("permit_conditions").select("id").eq("id", condId)).data ?? []).toHaveLength(0);
  });
  it("an authenticated NON-member cannot add a condition to the org's permit (write-gated)", async () => {
    const { error } = await db(userClient(authToken)).from("permit_conditions")
      .insert({ org_id: orgId, permit_id: permitId, label: "intruder", required: true });
    expect(error, "non-member insert must be refused").not.toBeNull();
  });
});
