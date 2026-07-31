import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient, userClient } from "../_harness";
import {
  getSupplierPerformance,
  listSupplierPerformance,
  loadSupplierPerformanceSources,
  type PerformanceClient,
} from "@/server/services/supplier-performance";
import { loadSupplierForOrg, type SuppliersClient } from "@/server/services/suppliers";

/**
 * Supplier performance — active-org pinning against REAL Postgres.
 *
 * THE DEFECT THIS EXISTS TO PREVENT. Merchants are shared. The same JP Corry or
 * Jewson account serves both of an owner's companies, so each company keeps its
 * OWN `suppliers` row for the same real-world business. `current_org_ids()`
 * admits every org the viewer belongs to, which is correct for RLS — it enforces
 * the outer tenant boundary — but it does NOT constrain a read to the ACTIVE
 * org. Without an explicit org pin, a performance record computed for company A
 * would be counted over BOTH companies' orders, deliveries and bills, and the
 * operator would make a buying decision for company A on evidence from
 * company B. That is the read-side defect class #456/#459/#461/#463/#464/#468
 * spent six slices closing, and it is worse here than almost anywhere: the
 * output is not a stray row in a list, it is a NUMBER about a named company's
 * conduct.
 *
 * The fixtures make the two companies' records DELIBERATELY OPPOSITE, so a
 * blend cannot hide in a plausible-looking average:
 *
 *   org A  6 deliveries, every one EARLY   → 0 late of 6   (0%)
 *   org B  6 deliveries, every one 50 DAYS LATE → 6 late of 6 (100%)
 *
 * If the pin were removed, org A's page would read 6 late of 12 — 50% — and this
 * suite goes red on the exact figure a user would have been shown. The pages call
 * these same exported functions with a real client, so deleting an
 * `.eq("org_id", orgId)` in server/services/supplier-performance.ts fails HERE,
 * not just in review.
 *
 * It also proves against real triggers the two exclusions the metric layer only
 * asserts in the abstract: a VOIDED goods received note (posted, then voided
 * through the real lifecycle guard) counts for nothing, and a supplier from the
 * other org is indistinguishable from one that does not exist.
 *
 * Residue-independent: fixtures are namespaced by a per-run TOKEN and every
 * assertion is made against ids created by THIS run.
 */

type Row = Record<string, unknown>;
type Res<T> = { data: T | null; error: { message: string } | null };
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Upd extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Upd;
}
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Sel;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(row: Row): Upd;
  delete(): { eq(column: string, value: unknown): PromiseLike<Res<null>> };
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-perf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** The SAME merchant, traded with by both companies — the whole point. */
const MERCHANT = `${TOKEN} Shared Merchant Ltd`;

const PROMISED = "2026-06-10";
/** Org A always beats the promise. */
const A_DELIVERED = "2026-06-09";
/** Org B is always catastrophically late. */
const B_DELIVERED = "2026-07-30";

async function insId(svc: ReturnType<typeof db>, table: string, row: Row): Promise<string> {
  const res = await svc.from(table).insert(row).select("id").single();
  expect(res.error, `${table}: ${res.error?.message}`).toBeNull();
  const id = String(res.data?.id ?? "");
  if (!id) throw new Error(`failed to insert into ${table}`);
  return id;
}

async function mkUser(suffix: string, orgIds: string[]): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${suffix}@example.test`;
  const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
  // No auth.users → public.users trigger in this schema, so mirror the row
  // ourselves (memberships.user_id FKs public.users).
  await db(serviceClient()).from("users").insert({ id, email, full_name: email });
  for (const orgId of orgIds) {
    const m = await db(serviceClient())
      .from("memberships")
      .insert({ org_id: orgId, user_id: id, role: "owner" });
    expect(m.error, m.error?.message).toBeNull();
  }
  const signIn = await serviceClient().auth.signInWithPassword({ email, password });
  const token = signIn.data.session?.access_token ?? "";
  if (!id || !token) throw new Error(`failed to make user ${suffix}`);
  return { id, token };
}

describeIntegration("supplier performance · active-org pinning (RLS)", () => {
  const svc = db(serviceClient());

  let orgA = "";
  let orgB = "";
  /** Owner of BOTH orgs, "working in" org A — the blend probe. */
  let dual = { id: "", token: "" };
  /** Member of org B ONLY — the RLS control. */
  let outsider = { id: "", token: "" };

  let supplierA = "";
  let supplierB = "";

  /**
   * Create a PO with one line, plus a POSTED goods received note against it.
   *
   * The GRN goes through the REAL lifecycle — born draft (the trigger refuses
   * anything else even for the service role), lines added while it is still a
   * draft, then transitioned to 'posted'. Inserting a posted note directly is
   * impossible by design, and going through the real path is what makes the void
   * exclusion below a genuine proof rather than a restatement of the fixture.
   */
  async function order(opts: {
    orgId: string;
    supplierId: string;
    seq: number;
    delivered: string;
    expected?: string | null;
    poStatus?: string;
    subtotal?: number;
    void?: boolean;
  }): Promise<{ poId: string; grnId: string }> {
    const poId = await insId(svc, "purchase_orders", {
      org_id: opts.orgId,
      supplier_id: opts.supplierId,
      number: `PO-${TOKEN}-${opts.seq}`,
      status: opts.poStatus ?? "sent",
      expected_date: opts.expected === undefined ? PROMISED : opts.expected,
      subtotal: opts.subtotal ?? 100,
      vat_total: 20,
    });
    const lineId = await insId(svc, "purchase_order_line_items", {
      org_id: opts.orgId,
      purchase_order_id: poId,
      description: "Blocks",
      qty: 10,
      unit: "ea",
      unit_price: 10,
      line_total: 100,
    });

    const grnId = await insId(svc, "goods_received_notes", {
      org_id: opts.orgId,
      purchase_order_id: poId,
      number: `GRN-${TOKEN}-${opts.seq}`,
      delivery_date: opts.delivered,
      // status omitted — the lifecycle trigger requires it to be born 'draft'.
    });
    const line = await svc.from("goods_received_lines").insert({
      org_id: opts.orgId,
      goods_received_note_id: grnId,
      purchase_order_line_item_id: lineId,
      qty_received: 10,
    });
    expect(line.error, `grn line: ${line.error?.message}`).toBeNull();

    const posted = await svc
      .from("goods_received_notes")
      .update({ status: "posted" })
      .eq("id", grnId);
    expect(posted.error, `post grn: ${posted.error?.message}`).toBeNull();

    if (opts.void) {
      const voided = await svc
        .from("goods_received_notes")
        .update({ status: "void", void_reason: "keyed against the wrong order" })
        .eq("id", grnId);
      expect(voided.error, `void grn: ${voided.error?.message}`).toBeNull();
    }

    return { poId, grnId };
  }

  beforeAll(async () => {
    orgA = await insId(svc, "organizations", { name: "Perf A", slug: `${TOKEN}-a` });
    orgB = await insId(svc, "organizations", { name: "Perf B", slug: `${TOKEN}-b` });
    dual = await mkUser("dual", [orgA, orgB]);
    outsider = await mkUser("outsider", [orgB]);

    // The same merchant, once per company. Only org_id differs.
    supplierA = await insId(svc, "suppliers", {
      org_id: orgA,
      name: MERCHANT,
      category: "Builders merchant",
    });
    supplierB = await insId(svc, "suppliers", {
      org_id: orgB,
      name: MERCHANT,
      category: "Builders merchant",
    });

    // Org A: six deliveries, every one a day EARLY.
    for (let i = 1; i <= 6; i += 1) {
      await order({ orgId: orgA, supplierId: supplierA, seq: i, delivered: A_DELIVERED });
    }
    // Org B: six deliveries, every one fifty days LATE.
    for (let i = 11; i <= 16; i += 1) {
      await order({ orgId: orgB, supplierId: supplierB, seq: i, delivered: B_DELIVERED });
    }

    // Org A also has one POSTED-THEN-VOIDED late delivery, which must count for
    // nothing at all — void-with-a-reason is the correction path.
    await order({
      orgId: orgA,
      supplierId: supplierA,
      seq: 90,
      delivered: B_DELIVERED,
      void: true,
    });

    // A bill over its order in EACH company, with very different excesses.
    const aOver = await order({
      orgId: orgA,
      supplierId: supplierA,
      seq: 91,
      delivered: A_DELIVERED,
      subtotal: 100,
    });
    // amount is NET; vat_total is generated at 20% ⇒ gross 240 against a 120 order.
    const aBill = await svc.from("finances").insert({
      org_id: orgA,
      supplier_id: supplierA,
      purchase_order_id: aOver.poId,
      amount: 200,
      vat_rate: 20,
      category: "materials",
      bill_date: "2026-06-15",
      reference: `${TOKEN}-A-INV`,
    });
    expect(aBill.error, `org A bill: ${aBill.error?.message}`).toBeNull();

    const bOver = await order({
      orgId: orgB,
      supplierId: supplierB,
      seq: 92,
      delivered: B_DELIVERED,
      subtotal: 100,
    });
    const bBill = await svc.from("finances").insert({
      org_id: orgB,
      supplier_id: supplierB,
      purchase_order_id: bOver.poId,
      amount: 5000,
      vat_rate: 20,
      category: "materials",
      bill_date: "2026-06-15",
      reference: `${TOKEN}-B-INV`,
    });
    expect(bBill.error, `org B bill: ${bBill.error?.message}`).toBeNull();
  });

  afterAll(async () => {
    // Deleting the organizations cascades through every fixture table.
    for (const org of [orgA, orgB]) {
      if (org) await svc.from("organizations").delete().eq("id", org);
    }
    for (const u of [dual, outsider]) {
      if (u.id) {
        await svc.from("users").delete().eq("id", u.id);
        await serviceClient().auth.admin.deleteUser(u.id);
      }
    }
  });

  // -------------------------------------------------------------------------
  // The blend probe
  // -------------------------------------------------------------------------

  it("computes org A's record from org A's history ONLY", async () => {
    const client = userClient(dual.token) as unknown as PerformanceClient;
    const { performance } = await getSupplierPerformance(client, orgA, supplierA, MERCHANT);

    // 6 early + 1 over-billed early = 7 posted deliveries. The VOIDED one is
    // excluded, and org B's six do not exist as far as org A is concerned.
    expect(performance.delivery.deliveries).toBe(7);
    expect(performance.delivery.excluded.voided).toBe(1);

    // THE FIGURE A BLEND WOULD BREAK: org A is never late.
    expect(performance.delivery.punctuality.count).toBe(0);
    expect(performance.delivery.punctuality.n).toBe(7);
    expect(performance.delivery.punctuality.pct).toBe(0);
    expect(performance.delivery.onTime).toBe(7);
    expect(performance.delivery.lateBands).toEqual({
      days1to3: 0,
      days4to7: 0,
      days8plus: 0,
    });
  });

  it("computes org B's record from org B's history ONLY", async () => {
    // The mirror image, so a pin that accidentally hard-coded one org fails too.
    const client = userClient(dual.token) as unknown as PerformanceClient;
    const { performance } = await getSupplierPerformance(client, orgB, supplierB, MERCHANT);

    expect(performance.delivery.deliveries).toBe(7);
    expect(performance.delivery.punctuality.count).toBe(7);
    expect(performance.delivery.punctuality.pct).toBe(100);
    expect(performance.delivery.lateBands.days8plus).toBe(7);
  });

  it("keeps the other company's over-invoicing out of the money figure", async () => {
    const client = userClient(dual.token) as unknown as PerformanceClient;
    const a = await getSupplierPerformance(client, orgA, supplierA, MERCHANT);
    const b = await getSupplierPerformance(client, orgB, supplierB, MERCHANT);

    // Org A: one bill of £240 gross against a £120 order ⇒ £120 excess.
    expect(a.performance.price.overBilled.count).toBe(1);
    expect(a.performance.price.overBilled.n).toBe(1);
    expect(a.performance.price.overBilledExcess).toBe(120);

    // Org B: £6,000 gross against £120 ⇒ £5,880. If these blended, org A's
    // excess would be £6,000.
    expect(b.performance.price.overBilledExcess).toBe(5880);
    expect(a.performance.price.overBilledExcess).not.toBe(
      b.performance.price.overBilledExcess,
    );
  });

  it("returns nothing when a supplier id is read under the wrong org", async () => {
    const client = userClient(dual.token) as unknown as PerformanceClient;
    // org B's supplier, pinned to org A: every read is scoped by BOTH, so the
    // combination matches no row rather than leaking org B's trading history.
    const sources = await loadSupplierPerformanceSources(client, orgA, supplierB);
    expect(sources.purchaseOrders).toEqual([]);
    expect(sources.grns).toEqual([]);
    expect(sources.bills).toEqual([]);
    expect(sources.payments).toEqual([]);
  });

  it("makes the other org's supplier indistinguishable from a missing one", async () => {
    // The page's own gate: loadSupplierForOrg returns null and the route 404s,
    // so a performance record for another company's supplier is unreachable even
    // before the metric reads run.
    const client = userClient(dual.token) as unknown as SuppliersClient;
    expect(await loadSupplierForOrg(client, orgA, supplierB, "id, name")).toBeNull();
    // …and the same id resolves fine in its OWN org, proving the null above is
    // the pin and not a broken fixture.
    expect(await loadSupplierForOrg(client, orgB, supplierB, "id, name")).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // The comparison view
  // -------------------------------------------------------------------------

  it("compares only the active org's suppliers", async () => {
    const client = userClient(dual.token) as unknown as PerformanceClient;
    const rows = await listSupplierPerformance(client, orgA, [
      { id: supplierA, name: MERCHANT },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.delivery.deliveries).toBe(7);
    expect(rows[0]?.delivery.punctuality.pct).toBe(0);
    expect(rows[0]?.empty).toBe(false);
  });

  it("reports nothing for another org's supplier even when asked directly", async () => {
    // The comparison takes a roster, so the pin has to hold even if a caller
    // passes an id from the wrong company: the row comes back EMPTY, never
    // populated from org B.
    const client = userClient(dual.token) as unknown as PerformanceClient;
    const rows = await listSupplierPerformance(client, orgA, [
      { id: supplierB, name: MERCHANT },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.empty).toBe(true);
    expect(rows[0]?.delivery.deliveries).toBe(0);
    expect(rows[0]?.price.overBilledExcess).toBe(0);
  });

  // -------------------------------------------------------------------------
  // RLS is still the outer boundary
  // -------------------------------------------------------------------------

  it("gives a member of only org B nothing for org A's supplier", async () => {
    // Not the same defect — this one IS a tenant boundary, and RLS enforces it
    // regardless of the pin. Asserted so a future refactor cannot trade the
    // outer boundary for the inner one.
    const client = userClient(outsider.token) as unknown as PerformanceClient;
    const sources = await loadSupplierPerformanceSources(client, orgA, supplierA);
    expect(sources.purchaseOrders).toEqual([]);
    expect(sources.grns).toEqual([]);
    expect(sources.bills).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The void exclusion, against the real lifecycle triggers
  // -------------------------------------------------------------------------

  it("proves the voided note really is voided in the database", async () => {
    // Guards the guard: if the fixture's void had silently failed, the
    // "excluded.voided === 1" assertion above would be measuring nothing.
    // `goods_received_notes` post-dates the generated types, so the read goes
    // through the same loose shim the fixtures use.
    const res = await svc
      .from("goods_received_notes")
      .select("id, status, void_reason, voided_at")
      .eq("org_id", orgA)
      .eq("number", `GRN-${TOKEN}-90`);
    expect(res.error, res.error?.message).toBeNull();
    const row = (res.data ?? [])[0] as
      | { status?: string; void_reason?: string | null; voided_at?: string | null }
      | undefined;
    expect(row?.status).toBe("void");
    expect(row?.void_reason).toBeTruthy();
    // The lifecycle trigger pins the provenance, so this is set even though the
    // fixture never supplied it.
    expect(row?.voided_at).toBeTruthy();
  });
});
