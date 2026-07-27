import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Completion-certificate cross-tenant integrity (20261024) — proven against real
 * Postgres. A completion_certificate can NEVER reference another org's job or
 * customer: this is the DB-enforced guard every sibling table already has
 * (purchase_orders 20261011, risk_assessments 20261018, finances bills 20261009).
 * Its absence let an org-A member POST a cert bound to org B's job/customer
 * (a cross-tenant write) and squat org B's `one_live_per_job` unique slot (a
 * cross-org DoS on cert issuance). The guard fires for service_role too.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del extends PromiseLike<Res<null>> {
  eq(column: string, value: unknown): Del;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };
const TOKEN = `it-cc-org-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const COMPLETION_DATE = "2026-07-01";

describeIntegration("Completion certificate · cross-tenant org-integrity (20261024)", () => {
  let orgA = "";
  let orgB = "";
  let jobB = "";
  let customerB = "";
  let jobA = "";
  let customerA = "";

  beforeAll(async () => {
    const svc = db(serviceClient());
    orgA = String((await svc.from("organizations").insert({ name: "CC A", slug: `${TOKEN}-a` }).select("id").single()).data?.id ?? "");
    orgB = String((await svc.from("organizations").insert({ name: "CC B", slug: `${TOKEN}-b` }).select("id").single()).data?.id ?? "");
    jobB = String((await svc.from("jobs").insert({ org_id: orgB, status: "new" }).select("id").single()).data?.id ?? "");
    customerB = String((await svc.from("customers").insert({ org_id: orgB, name: "Customer B" }).select("id").single()).data?.id ?? "");
    jobA = String((await svc.from("jobs").insert({ org_id: orgA, status: "new" }).select("id").single()).data?.id ?? "");
    customerA = String((await svc.from("customers").insert({ org_id: orgA, name: "Customer A" }).select("id").single()).data?.id ?? "");
    if (!orgA || !orgB || !jobB || !customerB || !jobA || !customerA) throw new Error("fixture setup failed");
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
  });

  it("rejects a cert in org A that references org B's job", async () => {
    const r = await db(serviceClient())
      .from("completion_certificates")
      .insert({ org_id: orgA, certificate_number: `${TOKEN}-XJ`, completion_date: COMPLETION_DATE, job_id: jobB })
      .select("id")
      .single();
    expect(r.error, "cross-org job must be rejected").not.toBeNull();
    expect(r.error?.message ?? "").toMatch(/not in this org/i);
  });

  it("rejects a cert in org A that references org B's customer", async () => {
    const r = await db(serviceClient())
      .from("completion_certificates")
      .insert({ org_id: orgA, certificate_number: `${TOKEN}-XC`, completion_date: COMPLETION_DATE, customer_id: customerB })
      .select("id")
      .single();
    expect(r.error, "cross-org customer must be rejected").not.toBeNull();
    expect(r.error?.message ?? "").toMatch(/not in this org/i);
  });

  it("accepts a cert whose job + customer are both in the same org", async () => {
    const r = await db(serviceClient())
      .from("completion_certificates")
      .insert({ org_id: orgA, certificate_number: `${TOKEN}-OK`, completion_date: COMPLETION_DATE, job_id: jobA, customer_id: customerA })
      .select("id")
      .single();
    expect(r.error, "same-org cert must be accepted").toBeNull();
    expect(r.data?.id).toBeTruthy();
  });
});
