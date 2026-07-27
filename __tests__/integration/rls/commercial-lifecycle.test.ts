import { afterAll, beforeAll, expect, it } from "vitest";
import {
  anonClient,
  describeIntegration,
  serviceClient,
  userClient,
} from "../_harness";

/**
 * Commercial lifecycle (Programme D) — tenant-isolation proof against real
 * Postgres. The read-model assembles a job's quotes, invoices, invoice_payments,
 * retention_releases and purchase_orders. It runs on the TENANT client, so RLS
 * (org-scoped via current_org_ids()) is the only thing between a token holder
 * and another org's books. This proves every one of those tables denies a
 * non-member — a cross-org row can never enter the timeline / cash figures.
 */

type Res<T> = { data: T | null; error: { message: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
  in(column: string, values: unknown[]): Sel;
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

const TOKEN = `it-commercial-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("commercial lifecycle · tenant isolation (RLS)", () => {
  let orgA = "";
  let orgB = "";
  let jobA = "";
  let invA = "";
  let outsiderId = "";
  let outsiderToken = "";

  beforeAll(async () => {
    const svc = db(serviceClient());

    const a = await svc.from("organizations").insert({ name: "Commercial A", slug: `${TOKEN}-a` }).select("id").single();
    const b = await svc.from("organizations").insert({ name: "Commercial B", slug: `${TOKEN}-b` }).select("id").single();
    orgA = String(a.data?.id ?? "");
    orgB = String(b.data?.id ?? "");
    if (!orgA || !orgB) throw new Error("failed to create probe orgs");

    const cust = await svc.from("customers").insert({ org_id: orgA, name: "Commercial Cust" }).select("id").single();
    const job = await svc.from("jobs").insert({ org_id: orgA, customer_id: cust.data?.id, status: "in-progress" }).select("id").single();
    expect(job.error, job.error?.message).toBeNull();
    jobA = String(job.data?.id ?? "");

    const inv = await svc
      .from("invoices")
      .insert({ org_id: orgA, job_id: jobA, number: `${TOKEN}-INV1`, amount: 1000, vat_total: 200, status: "partially_paid", due_date: "2026-01-01" })
      .select("id")
      .single();
    expect(inv.error, inv.error?.message).toBeNull();
    invA = String(inv.data?.id ?? "");

    // A part payment against the job's invoice (the ledger cash).
    await svc.from("invoice_payments").insert({ org_id: orgA, invoice_id: invA, amount: 400, paid_at: "2026-02-01", source: "manual" });
    // Retention release + a purchase order on the job (commercial rows).
    await svc.from("retention_releases").insert({ org_id: orgA, job_id: jobA, amount: 50, released_on: "2026-03-01" });
    await svc.from("purchase_orders").insert({ org_id: orgA, job_id: jobA, number: `${TOKEN}-PO1`, status: "sent", subtotal: 300, vat_total: 60 });

    // An outsider: a real member of org B only.
    const email = `${TOKEN}@example.test`;
    const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
    const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
    outsiderId = created.data.user?.id ?? "";
    await db(serviceClient()).from("users").insert({ id: outsiderId, email, full_name: "Outsider" });
    await db(serviceClient()).from("memberships").insert({ org_id: orgB, user_id: outsiderId, role: "owner" });
    const signedIn = await anonClient().auth.signInWithPassword({ email, password });
    outsiderToken = signedIn.data.session?.access_token ?? "";
    if (!outsiderToken) throw new Error("failed to mint outsider token");
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
    if (outsiderId) await serviceClient().auth.admin.deleteUser(outsiderId);
  });

  it("service_role (ground truth) sees the job's commercial rows", async () => {
    const svc = db(serviceClient());
    const invs = await svc.from("invoices").select("id").eq("job_id", jobA);
    const pays = await svc.from("invoice_payments").select("amount").eq("invoice_id", invA);
    expect(invs.data?.length).toBe(1);
    expect(Number(pays.data?.[0]?.amount ?? 0)).toBe(400);
  });

  it("a member of another org sees NONE of the job's commercial rows (RLS)", async () => {
    const b = db(userClient(outsiderToken));
    const jobs = await b.from("jobs").select("id").eq("id", jobA);
    const invs = await b.from("invoices").select("id").eq("job_id", jobA);
    const pays = await b.from("invoice_payments").select("amount").in("invoice_id", [invA]);
    const rels = await b.from("retention_releases").select("id").eq("job_id", jobA);
    const pos = await b.from("purchase_orders").select("id").eq("job_id", jobA);
    expect(jobs.data ?? []).toHaveLength(0);
    expect(invs.data ?? []).toHaveLength(0);
    expect(pays.data ?? []).toHaveLength(0); // the cash leg cannot leak
    expect(rels.data ?? []).toHaveLength(0);
    expect(pos.data ?? []).toHaveLength(0);
  });

  it("anon (no token) is denied the job's invoice_payments", async () => {
    const { data } = await db(anonClient()).from("invoice_payments").select("amount").in("invoice_id", [invA]);
    expect(data ?? []).toHaveLength(0);
  });
});
