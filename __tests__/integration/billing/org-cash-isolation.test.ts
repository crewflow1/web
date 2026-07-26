import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * H2-CASH M2 — the /cash surface aggregates invoices + invoice_payments +
 * job_billing_stages. This proves those reads are tenant-scoped: a member of
 * org B sees ZERO of org A's cash rows (and anon sees none), so the owner cash
 * view can never leak another tenant's money.
 */

type Res = { data: Array<Record<string, unknown>> | null; error: unknown };
interface Sel extends PromiseLike<Res> { eq(c: string, v: unknown): Sel; select(c: string): Sel }
const db = (c: unknown) => c as unknown as { from(t: string): { select(c: string): Sel; insert(r: Record<string, unknown>): { select(c: string): { single(): PromiseLike<{ data: { id: string } | null; error: unknown }> } }; delete(): { eq(c: string, v: unknown): PromiseLike<Res> } } };
const T = `it-orgcash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("H2-CASH org cash isolation (real Postgres)", () => {
  let orgA = "", orgB = "", custA = "", jobA = "", planA = "";
  let memberB = { id: "", token: "" };
  const svc = () => db(serviceClient());

  beforeAll(async () => {
    orgA = String((await svc().from("organizations").insert({ name: "OC A", slug: `${T}-a` }).select("id").single()).data?.id);
    orgB = String((await svc().from("organizations").insert({ name: "OC B", slug: `${T}-b` }).select("id").single()).data?.id);
    custA = String((await svc().from("customers").insert({ org_id: orgA, name: "Cust A" }).select("id").single()).data?.id);
    jobA = String((await svc().from("jobs").insert({ org_id: orgA, status: "new", customer_id: custA }).select("id").single()).data?.id);
    // An org-A invoice + a payment + a billing plan/stage — the cash-surface rows.
    const inv = String((await svc().from("invoices").insert({ org_id: orgA, job_id: jobA, customer_id: custA, number: `${T}-INV1`, amount: 1000, vat_total: 200, status: "sent" }).select("id").single()).data?.id);
    await svc().from("invoice_payments").insert({ org_id: orgA, invoice_id: inv, amount: 500, paid_at: "2026-07-20" });
    planA = String((await svc().from("job_billing_plans").insert({ org_id: orgA, job_id: jobA, structure: "staged", basis_amount: 5000, status: "active" }).select("id").single()).data?.id);
    await svc().from("job_billing_stages").insert({ org_id: orgA, plan_id: planA, job_id: jobA, sequence: 0, name: "S1", kind: "stage", basis: "fixed", amount: 2000, vat_rate: 20 });

    const email = `${T}-b@x.test`;
    const created = await serviceClient().auth.admin.createUser({ email, password: `Pw-${T}`, email_confirm: true });
    const id = created.data.user?.id ?? "";
    await svc().from("users").insert({ id, email, full_name: "b" });
    await svc().from("memberships").insert({ org_id: orgB, user_id: id, role: "admin" });
    const s = await anonClient().auth.signInWithPassword({ email, password: `Pw-${T}` });
    memberB = { id, token: s.data.session?.access_token ?? "" };
  });
  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (orgB) await svc().from("organizations").delete().eq("id", orgB);
    if (memberB.id) await serviceClient().auth.admin.deleteUser(memberB.id);
  });

  it("a member of another org sees NONE of org A's invoices / payments / billing stages", async () => {
    const asB = db(userClient(memberB.token));
    expect(((await asB.from("invoices").select("id").eq("org_id", orgA)).data ?? []).length).toBe(0);
    expect(((await asB.from("invoice_payments").select("id").eq("org_id", orgA)).data ?? []).length).toBe(0);
    expect(((await asB.from("job_billing_stages").select("id").eq("org_id", orgA)).data ?? []).length).toBe(0);
  });

  it("anon sees none of the cash surface", async () => {
    const asAnon = db(anonClient());
    expect(((await asAnon.from("invoices").select("id").eq("org_id", orgA)).data ?? []).length).toBe(0);
    expect(((await asAnon.from("job_billing_stages").select("id").eq("org_id", orgA)).data ?? []).length).toBe(0);
  });
});
