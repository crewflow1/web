import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";

/**
 * Purchase orders — schema invariants against real Postgres (migration
 * 20261006000000): per-org number allocation, number uniqueness, line-item
 * cascade, supplier SET NULL (audit preservation), and the generated total.
 * Service-role (RLS-bypassing) client — if it holds for the most privileged
 * writer it holds for every app path.
 */

type Res = { data: Record<string, unknown> | null; error: { message: string; code?: string } | null };
type Db = {
  from: (t: string) => {
    insert: (v: unknown) => Promise<{ error: { message: string; code?: string } | null }> & {
      select: (c: string) => { single: () => Promise<Res> };
    };
    select: (c: string) => { eq: (k: string, v: unknown) => Promise<{ data: unknown[] | null; error: unknown }> };
    delete: () => { eq: (k: string, v: unknown) => Promise<{ error: { message: string } | null }> };
  };
  rpc: (fn: string, args: unknown) => Promise<{ data: unknown; error: { message: string } | null }>;
};
const db = (c: unknown): Db => c as unknown as Db;

const TOKEN = `it-po-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describeIntegration("purchase orders · schema invariants (20261006)", () => {
  let orgA = "";
  let orgB = "";
  let supA = "";
  const svc = () => db(serviceClient());

  const mkPo = (org: string, number: string, subtotal = 100, vat = 20, supplier: string | null = null) =>
    svc()
      .from("purchase_orders")
      .insert({ org_id: org, number, subtotal, vat_total: vat, supplier_id: supplier })
      .select("id, total, status")
      .single();

  beforeAll(async () => {
    for (const [label, slug] of [
      ["A", `${TOKEN}-a`],
      ["B", `${TOKEN}-b`],
    ] as const) {
      const o = await svc().from("organizations").insert({ name: `PO ${label}`, slug }).select("id").single();
      expect(o.error, o.error?.message).toBeNull();
      if (label === "A") orgA = o.data!.id as string;
      else orgB = o.data!.id as string;
    }
    const s = await svc().from("suppliers").insert({ org_id: orgA, name: "Supplier A" }).select("id").single();
    supA = s.data!.id as string;
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) if (id) await svc().from("organizations").delete().eq("id", id);
  });

  it("next_po_number allocates sequentially and PER-ORG", async () => {
    const a1 = await svc().rpc("next_po_number", { target_org: orgA });
    expect(a1.error, a1.error?.message).toBeNull();
    expect(a1.data).toBe("PO-0001");
    await mkPo(orgA, a1.data as string);

    const a2 = await svc().rpc("next_po_number", { target_org: orgA });
    expect(a2.data).toBe("PO-0002"); // advanced past the inserted PO-0001

    // Org B is a fresh sequence — org A's PO doesn't bump it.
    const b1 = await svc().rpc("next_po_number", { target_org: orgB });
    expect(b1.data).toBe("PO-0001");
  });

  it("computes total as subtotal + vat_total (generated column)", async () => {
    const po = await mkPo(orgA, `${TOKEN}-T1`, 250.5, 50.1);
    expect(po.error, po.error?.message).toBeNull();
    expect(Number(po.data?.total)).toBe(300.6);
    expect(po.data?.status).toBe("draft"); // default
  });

  it("REJECTS a duplicate (org_id, number)", async () => {
    const num = `${TOKEN}-DUP`;
    expect((await mkPo(orgA, num)).error).toBeNull();
    const dup = await mkPo(orgA, num);
    expect(dup.error).not.toBeNull();
    expect(dup.error?.code).toBe("23505"); // unique_violation

    // ...but the SAME number is fine in a different org.
    expect((await mkPo(orgB, num)).error).toBeNull();
  });

  it("cascades line items when the PO is deleted", async () => {
    const po = await mkPo(orgA, `${TOKEN}-LI`);
    const poId = po.data?.id as string;
    const li = await svc()
      .from("purchase_order_line_items")
      .insert({ org_id: orgA, purchase_order_id: poId, description: "Bricks", qty: 100, unit_price: 0.5, vat_rate: 20, line_total: 50, sort_order: 0 });
    expect(li.error, li.error?.message).toBeNull();

    const del = await svc().from("purchase_orders").delete().eq("id", poId);
    expect(del.error, del.error?.message).toBeNull();

    const left = await svc().from("purchase_order_line_items").select("id").eq("purchase_order_id", poId);
    expect(left.data ?? []).toHaveLength(0);
  });

  it("keeps the PO but nulls supplier_id when the supplier is deleted (audit)", async () => {
    const po = await mkPo(orgA, `${TOKEN}-SUP`, 100, 20, supA);
    const poId = po.data?.id as string;

    const del = await svc().from("suppliers").delete().eq("id", supA);
    expect(del.error, del.error?.message).toBeNull();

    const after = await svc().from("purchase_orders").select("id, supplier_id").eq("id", poId);
    const row = (after.data ?? [])[0] as { supplier_id: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row?.supplier_id).toBeNull(); // SET NULL, PO preserved
  });
});
