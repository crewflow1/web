import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";

/**
 * H2-CASH billing plans — DB-enforced against real Postgres.
 *   - plan/stage writes are ADMIN-only (RLS is_org_admin), members read;
 *   - cross-tenant plan/stage writes are rejected (with-check + guard trigger);
 *   - generate_stage_invoice makes a proper job-scoped, quote_id-NULL invoice
 *     with a line item, and is idempotent (a stage bills once);
 *   - a non-admin cannot generate; a customerless job cannot be invoiced;
 *   - Σ(stage) may not exceed the contract basis; an invoiced stage is frozen.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> { eq(c: string, v: unknown): Sel; maybeSingle(): PromiseLike<Res<Row>> }
interface Upd extends PromiseLike<Res<null>> { eq(c: string, v: unknown): Upd }
interface Ins extends PromiseLike<Res<Row[]>> { select(c?: string): { single(): PromiseLike<Res<Row>> } }
interface Table { select(c?: string): Sel; insert(r: Row): Ins; update(v: Row): Upd; delete(): { eq(c: string, v: unknown): PromiseLike<Res<null>> } }
type Client = { from(t: string): Table; rpc(fn: string, args: Row): PromiseLike<Res<unknown>> };
const db = (c: unknown) => c as unknown as Client;
const T = `it-bill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("H2-CASH billing plans (real Postgres)", () => {
  let orgA = "", orgB = "";
  let custA = "", jobA = "", jobNoCust = "";
  let admin = { id: "", token: "" }, member = { id: "", token: "" }, adminB = { id: "", token: "" };
  const svc = () => db(serviceClient());

  async function mkMember(orgId: string, role: string, tag: string) {
    const email = `${T}-${tag}@x.test`;
    const created = await serviceClient().auth.admin.createUser({ email, password: `Pw-${T}`, email_confirm: true });
    if (created.error) throw new Error(created.error.message);
    const id = created.data.user?.id ?? "";
    await svc().from("users").insert({ id, email, full_name: tag });
    await svc().from("memberships").insert({ org_id: orgId, user_id: id, role });
    const s = await anonClient().auth.signInWithPassword({ email, password: `Pw-${T}` });
    if (s.error) throw new Error(s.error.message);
    return { id, token: s.data.session?.access_token ?? "" };
  }
  const mkPlan = async (org: string, job: string, basis: number) =>
    String((await svc().from("job_billing_plans").insert({ org_id: org, job_id: job, structure: "staged", basis_amount: basis, status: "active" }).select("id").single()).data?.id);
  const mkStage = async (org: string, plan: string, job: string, amount: number, seq = 0) =>
    String((await svc().from("job_billing_stages").insert({ org_id: org, plan_id: plan, job_id: job, sequence: seq, name: `Stage ${seq}`, kind: "stage", basis: "fixed", amount, vat_rate: 20 }).select("id").single()).data?.id);

  beforeAll(async () => {
    orgA = String((await svc().from("organizations").insert({ name: "BILL A", slug: `${T}-a` }).select("id").single()).data?.id);
    orgB = String((await svc().from("organizations").insert({ name: "BILL B", slug: `${T}-b` }).select("id").single()).data?.id);
    custA = String((await svc().from("customers").insert({ org_id: orgA, name: "Cust A" }).select("id").single()).data?.id);
    jobA = String((await svc().from("jobs").insert({ org_id: orgA, status: "new", customer_id: custA }).select("id").single()).data?.id);
    jobNoCust = String((await svc().from("jobs").insert({ org_id: orgA, status: "new" }).select("id").single()).data?.id);
    admin = await mkMember(orgA, "admin", "adm");
    member = await mkMember(orgA, "staff", "mem");
    adminB = await mkMember(orgB, "admin", "admb");
  });
  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (orgB) await svc().from("organizations").delete().eq("id", orgB);
    for (const m of [admin, member, adminB]) if (m.id) await serviceClient().auth.admin.deleteUser(m.id);
  });

  it("[RLS] an admin can create a plan; a staff member cannot", async () => {
    const asMember = await db(userClient(member.token)).from("job_billing_plans")
      .insert({ org_id: orgA, job_id: jobA, structure: "staged", basis_amount: 1000, status: "active" }).select("id").single();
    expect(asMember.error, "staff must be RLS-denied plan creation").not.toBeNull();

    const asAdmin = await db(userClient(admin.token)).from("job_billing_plans")
      .insert({ org_id: orgA, job_id: jobA, structure: "staged", basis_amount: 20000, status: "active" }).select("id").single();
    expect(asAdmin.error, asAdmin.error?.message).toBeNull();
    // cleanup this plan so later tests start clean
    if (asAdmin.data?.id) await svc().from("job_billing_plans").delete().eq("id", String(asAdmin.data.id));
  });

  it("[tenant] an admin of another org cannot create a plan on this org's job", async () => {
    const bad = await db(userClient(adminB.token)).from("job_billing_plans")
      .insert({ org_id: orgB, job_id: jobA, structure: "staged", basis_amount: 1000, status: "active" }).select("id").single();
    // org_id=orgB but job belongs to orgA → the job-org guard trigger rejects it.
    expect(bad.error?.message ?? "", "cross-tenant job binding must be rejected").toMatch(/job|org/i);
  });

  it("[invariant] Σ(stage) may not exceed the contract basis", async () => {
    const plan = await mkPlan(orgA, jobA, 10000);
    await mkStage(orgA, plan, jobA, 6000, 0);
    const over = await svc().from("job_billing_stages")
      .insert({ org_id: orgA, plan_id: plan, job_id: jobA, sequence: 1, name: "Too big", kind: "stage", basis: "fixed", amount: 6000, vat_rate: 20 }).select("id").single();
    expect(over.error?.message ?? "", "over-basis stage must be rejected").toMatch(/exceed|basis/i);
    await svc().from("job_billing_plans").delete().eq("id", plan);
  });

  it("[RPC] generate makes a job-scoped, quote-NULL invoice + line item, sets the stage, and bills once", async () => {
    const plan = await mkPlan(orgA, jobA, 20000);
    const stage = await mkStage(orgA, plan, jobA, 4000, 0);

    const gen = await db(userClient(admin.token)).rpc("generate_stage_invoice", { p_stage_id: stage, p_due_date: null });
    expect(gen.error, gen.error?.message).toBeNull();
    const invId = String(gen.data);

    const inv = (await svc().from("invoices").select("id, org_id, job_id, quote_id, customer_id, amount, vat_total, status").eq("id", invId).maybeSingle()).data as Row;
    expect(inv.job_id).toBe(jobA);
    expect(inv.quote_id).toBeNull();
    expect(inv.customer_id).toBe(custA);
    expect(Number(inv.amount)).toBe(4000);
    expect(Number(inv.vat_total)).toBe(800); // 20%
    expect(inv.status).toBe("draft");

    const lines = (await svc().from("invoice_line_items").select("id").eq("invoice_id", invId)).data ?? [];
    expect(lines.length).toBe(1);

    const stageRow = (await svc().from("job_billing_stages").select("invoice_id").eq("id", stage).maybeSingle()).data as Row;
    expect(stageRow.invoice_id).toBe(invId);

    // Idempotent: a second generation of the same stage is rejected.
    const again = await db(userClient(admin.token)).rpc("generate_stage_invoice", { p_stage_id: stage, p_due_date: null });
    expect(again.error?.message ?? "", "a stage bills once").toMatch(/already been invoiced/i);

    // Immutable: the invoiced stage cannot be re-priced (all roles).
    const reprice = await svc().from("job_billing_stages").update({ amount: 9999 }).eq("id", stage);
    expect(reprice.error?.message ?? "", "invoiced stage is frozen").toMatch(/re-priced|invoiced/i);

    await svc().from("job_billing_plans").delete().eq("id", plan);
  });

  it("[authz] a staff member cannot generate a stage invoice", async () => {
    const plan = await mkPlan(orgA, jobA, 5000);
    const stage = await mkStage(orgA, plan, jobA, 1000, 0);
    const gen = await db(userClient(member.token)).rpc("generate_stage_invoice", { p_stage_id: stage, p_due_date: null });
    expect(gen.error?.message ?? "", "only admin can generate").toMatch(/owner or admin/i);
    await svc().from("job_billing_plans").delete().eq("id", plan);
  });

  it("[guard] a job with no customer cannot be invoiced", async () => {
    const plan = await mkPlan(orgA, jobNoCust, 5000);
    const stage = await mkStage(orgA, plan, jobNoCust, 1000, 0);
    const gen = await db(userClient(admin.token)).rpc("generate_stage_invoice", { p_stage_id: stage, p_due_date: null });
    expect(gen.error?.message ?? "", "customerless job is guarded").toMatch(/customer/i);
    await svc().from("job_billing_plans").delete().eq("id", plan);
  });

  it("[guard] a cancelled plan cannot generate invoices", async () => {
    const plan = await mkPlan(orgA, jobA, 5000);
    const stage = await mkStage(orgA, plan, jobA, 1000, 0);
    await svc().from("job_billing_plans").update({ status: "cancelled" }).eq("id", plan);
    const gen = await db(userClient(admin.token)).rpc("generate_stage_invoice", { p_stage_id: stage, p_due_date: null });
    expect(gen.error?.message ?? "", "a cancelled plan cannot invoice").toMatch(/not active/i);
    await svc().from("job_billing_plans").delete().eq("id", plan);
  });

  it("[tenant] anon cannot read billing plans", async () => {
    const plan = await mkPlan(orgA, jobA, 1000);
    const sel = await db(anonClient()).from("job_billing_plans").select("id").eq("id", plan);
    expect((sel.data ?? []).length).toBe(0);
    await svc().from("job_billing_plans").delete().eq("id", plan);
  });
});
