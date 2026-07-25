import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Programme E reconciliation fixes — proven against real Postgres.
 *
 *  F1 — purchase-order cross-tenant integrity (20261011): a PO / line item can
 *       never reference another org's supplier, job, or parent PO.
 *  F3 — retention no-over-release is race-safe (20261012): concurrent releases
 *       against one job can never exceed the accrued retention (FOR UPDATE lock).
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
const TOKEN = `it-prog-e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("Programme E fixes · PO org-integrity + retention concurrency", () => {
  let orgA = "";
  let orgB = "";
  let supplierB = "";
  let jobB = "";
  let jobA = "";

  beforeAll(async () => {
    const svc = db(serviceClient());
    const a = await svc.from("organizations").insert({ name: "Prog-E A", slug: `${TOKEN}-a` }).select("id").single();
    const b = await svc.from("organizations").insert({ name: "Prog-E B", slug: `${TOKEN}-b` }).select("id").single();
    orgA = String(a.data?.id ?? "");
    orgB = String(b.data?.id ?? "");
    const sB = await svc.from("suppliers").insert({ org_id: orgB, name: "Foreign Supplier" }).select("id").single();
    supplierB = String(sB.data?.id ?? "");
    const jB = await svc.from("jobs").insert({ org_id: orgB, status: "new" }).select("id").single();
    jobB = String(jB.data?.id ?? "");
    const jA = await svc.from("jobs").insert({ org_id: orgA, status: "new" }).select("id").single();
    jobA = String(jA.data?.id ?? "");
    if (!orgA || !orgB || !supplierB || !jobB || !jobA) throw new Error("fixture setup failed");
  });

  afterAll(async () => {
    const svc = db(serviceClient());
    if (orgA) await svc.from("organizations").delete().eq("id", orgA);
    if (orgB) await svc.from("organizations").delete().eq("id", orgB);
  });

  // ---- F1 -----------------------------------------------------------------
  it("F1: rejects a PO in org A that references org B's supplier", async () => {
    const r = await db(serviceClient())
      .from("purchase_orders")
      .insert({ org_id: orgA, number: `${TOKEN}-PO-XS`, status: "draft", subtotal: 100, vat_total: 20, supplier_id: supplierB })
      .select("id")
      .single();
    expect(r.error, "cross-org supplier must be rejected").not.toBeNull();
    expect(r.error?.message ?? "").toMatch(/not in this org/i);
  });

  it("F1: rejects a PO in org A that references org B's job", async () => {
    const r = await db(serviceClient())
      .from("purchase_orders")
      .insert({ org_id: orgA, number: `${TOKEN}-PO-XJ`, status: "draft", subtotal: 100, vat_total: 20, job_id: jobB })
      .select("id")
      .single();
    expect(r.error, "cross-org job must be rejected").not.toBeNull();
  });

  it("F1: accepts a PO whose supplier + job are in the same org", async () => {
    const svc = db(serviceClient());
    const sA = await svc.from("suppliers").insert({ org_id: orgA, name: "Own Supplier" }).select("id").single();
    const r = await svc
      .from("purchase_orders")
      .insert({ org_id: orgA, number: `${TOKEN}-PO-OK`, status: "draft", subtotal: 100, vat_total: 20, supplier_id: sA.data?.id, job_id: jobA })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    expect(r.data?.id).toBeTruthy();

    // A line item pointing at that PO but tagged with org B is rejected.
    const li = await svc
      .from("purchase_order_line_items")
      .insert({ org_id: orgB, purchase_order_id: r.data?.id, description: "x", qty: 1, unit: "ea", unit_price: 100, vat_rate: 20, line_total: 100, sort_order: 0 })
      .select("id")
      .single();
    expect(li.error, "cross-org line item must be rejected").not.toBeNull();
  });

  // ---- F3 -----------------------------------------------------------------
  it("F3: concurrent retention releases never exceed the accrued amount", async () => {
    const svc = db(serviceClient());
    // Job with 5% retention and £10,000 net invoiced → accrued £500.
    const jr = await svc.from("jobs").insert({ org_id: orgA, status: "new", retention_percent: 5 }).select("id").single();
    const job = String(jr.data?.id ?? "");
    await svc.from("invoices").insert({ org_id: orgA, job_id: job, number: `${TOKEN}-RINV`, amount: 10000, vat_total: 2000, status: "sent" });

    // Two simultaneous £300 releases = £600 > £500 accrued. Exactly one wins.
    const release = () =>
      svc.from("retention_releases").insert({ org_id: orgA, job_id: job, amount: 300, released_on: "2026-07-21" }).select("id").single();
    const results = await Promise.allSettled([release(), release()]);
    const ok = results.filter((r) => r.status === "fulfilled" && !(r.value as Res<Row>).error).length;
    expect(ok, "exactly one release should succeed").toBe(1);

    const rel = await svc.from("retention_releases").select("amount").eq("job_id", job);
    const total = (rel.data ?? []).reduce((s, r) => s + Number(r.amount ?? 0), 0);
    expect(total).toBeLessThanOrEqual(500); // never over-released
    expect(total).toBe(300);
  });
});
