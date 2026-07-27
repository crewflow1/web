import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Supplier bills (20261009), against real Postgres.
 *
 * A supplier bill is a `finances` entry attributed to a supplier + purchase
 * order. The DB guard trigger `finances_bill_org_integrity` is the invariant: a
 * cost may only link to a PO/supplier in its OWN org. That must hold for EVERY
 * writer, so the suite runs on the service-role client (RLS-bypassing) — if the
 * guard holds against it, it holds for every app path.
 */

type Db = {
  from: (t: string) => {
    insert: (v: unknown) => Promise<{ error: { message: string; code?: string } | null }> & {
      select: (c: string) => { single: () => Promise<{ data: Record<string, unknown> | null; error: unknown }> };
    };
    select: (c: string) => {
      eq: (k: string, v: unknown) => Promise<{ data: unknown[] | null; error: unknown }>;
    };
    delete: () => { eq: (k: string, v: unknown) => Promise<{ error: unknown }> };
  };
};
const db = (c: unknown): Db => c as unknown as Db;
const TOKEN = `it-bills-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("finances · supplier bills org-integrity (20261009)", () => {
  let orgA = "";
  let orgB = "";
  let supplierA = "";
  let poA = "";
  let n = 0;
  const svc = () => db(serviceClient());

  const mkOrg = async (label: string) => {
    const o = await svc().from("organizations").insert({ name: `Bills ${label}`, slug: `${TOKEN}-${label}` }).select("id").single();
    expect(o.error, JSON.stringify(o.error)).toBeNull();
    return o.data?.id as string;
  };

  beforeAll(async () => {
    orgA = await mkOrg("a");
    orgB = await mkOrg("b");
    const s = await svc().from("suppliers").insert({ org_id: orgA, name: "Wholesale Electrical Ltd" }).select("id").single();
    supplierA = s.data?.id as string;
    n += 1;
    const po = await svc()
      .from("purchase_orders")
      .insert({ org_id: orgA, supplier_id: supplierA, number: `${TOKEN}-PO-${n}`, status: "sent" })
      .select("id")
      .single();
    expect(po.error, JSON.stringify(po.error)).toBeNull();
    poA = po.data?.id as string;
  });

  afterAll(async () => {
    // Teardown is ASSERTED, not fire-and-forget. Until 20261052 this delete
    // silently failed (activity_log_org_id_fkey — the finances rows below carry
    // an AFTER-DELETE activity trigger) and leaked every fixture row into the
    // shared database. Swallowing the error is what hid a P1 for so long, so
    // now a failed teardown fails the suite.
    for (const id of [orgA, orgB]) {
      if (!id) continue;
      const del = await svc().from("organizations").delete().eq("id", id);
      expect(del.error, `org teardown failed: ${JSON.stringify(del.error)}`).toBeNull();
      const residue = await svc().from("finances").select("id").eq("org_id", id);
      expect(residue.data ?? [], "finances rows leaked past org teardown").toHaveLength(0);
    }
  });

  it("records a bill against a same-org PO + supplier (posts to finances)", async () => {
    const r = await svc()
      .from("finances")
      .insert({
        org_id: orgA,
        purchase_order_id: poA,
        supplier_id: supplierA,
        amount: 500,
        vat_rate: 20,
        category: "Materials",
        reference: "WES-88421",
      })
      .select("id, vat_total, purchase_order_id")
      .single();
    expect(r.error, JSON.stringify(r.error)).toBeNull();
    expect(Number(r.data?.vat_total)).toBe(100); // generated 20% of 500
    expect(r.data?.purchase_order_id).toBe(poA);
  });

  it("REJECTS a bill whose org differs from the PO's org (cross-tenant guard)", async () => {
    const bad = await svc().from("finances").insert({
      org_id: orgB, // org B cost pointing at org A's PO
      purchase_order_id: poA,
      amount: 100,
      vat_rate: 20,
    });
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/not in this org/i);
  });

  it("REJECTS a bill whose org differs from the supplier's org", async () => {
    const bad = await svc().from("finances").insert({
      org_id: orgB,
      supplier_id: supplierA, // org A's supplier on an org B cost
      amount: 100,
      vat_rate: 20,
    });
    expect(bad.error).not.toBeNull();
    expect(bad.error?.message ?? "").toMatch(/not in this org/i);
  });

  it("still allows a plain cost with no PO/supplier link (ad-hoc expense)", async () => {
    const r = await svc().from("finances").insert({ org_id: orgB, amount: 42, vat_rate: 0, category: "Fuel" });
    expect(r.error, JSON.stringify(r.error)).toBeNull();
  });
});
