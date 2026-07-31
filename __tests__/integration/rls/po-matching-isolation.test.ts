import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import {
  loadPoMatchingQueue,
  loadSupplierBillVarianceSignal,
  type PoMatchingClient,
} from "@/server/services/po-matching";

/**
 * THREE-WAY BILL MATCHING — active-org isolation against REAL Postgres.
 *
 * The queue at /purchase-orders/matching joins THREE tables that each have an
 * `org_id in (select current_org_ids())` policy: purchase_orders,
 * goods_received_notes (+ lines) and finances. RLS is the outer boundary and is
 * correct — but `current_org_ids()` passes for EVERY org the viewer belongs to,
 * so for a dual-org member an RLS-ONLY read would:
 *
 *   1. list company B's over-billed orders inside company A's queue;
 *   2. add company B's variances into company A's headline totals; and
 *   3. worst of all, join across the two — B's delivery against A's invoice —
 *      inventing a variance that does not exist while hiding one that does.
 *
 * (3) is why this is worth a live test rather than a source grep: it is a
 * CORRECTNESS defect that produces confident, precise, wrong numbers about money.
 * Same class as #456 / #459 / #461 / #463 / #464 / #468.
 *
 * The page calls `loadPoMatchingQueue` exactly as this test does, so deleting the
 * pin in server/services/po-matching.ts goes red HERE, not just in review — and
 * the last test in this file proves the pin is LOAD-BEARING by reading the same
 * tables without it and showing both companies come back.
 *
 * Also proven live, because a mocked GRN cannot: the VOID path runs through the
 * real lifecycle trigger (20261059), and voiding a delivery must walk the
 * accrual back to zero rather than leaving phantom goods on the books.
 *
 * Residue-independent: fixtures are namespaced by a per-run TOKEN and every
 * assertion is made against ids created by THIS run.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  select(columns?: string): Sel;
  eq(column: string, value: unknown): Sel;
  in(column: string, values: readonly unknown[]): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Upd extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Upd;
}
interface Table {
  select(columns?: string): Sel;
  insert(rows: Row | Row[]): Ins;
  update(row: Row): Upd;
  delete(): Upd;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-3wm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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
  await db(serviceClient()).from("users").insert({ id, email, full_name: email });
  for (const orgId of orgIds) {
    const m = await db(serviceClient())
      .from("memberships")
      .insert({ org_id: orgId, user_id: id, role: "owner" });
    expect(m.error, m.error?.message).toBeNull();
  }
  const token =
    (await anonClient().auth.signInWithPassword({ email, password })).data.session?.access_token ??
    "";
  if (!id || !token) throw new Error(`failed to make user ${suffix}`);
  return { id, token };
}

describeIntegration("three-way bill matching · active-org isolation (RLS)", () => {
  const svc = db(serviceClient());

  let orgA = "";
  let orgB = "";
  /** Owner of BOTH orgs, "working in" org A — the blend probe. */
  let dual = { id: "", token: "" };

  /** org A: over-billed by exactly £120 (ordered £1,440, delivered £1,440, billed £1,560). */
  let poOverA = "";
  /** org A: fully delivered, never billed — a £1,440 accrual. */
  let poAccrualA = "";
  /** org A: delivered then VOIDED, and billed in full — must read billed-not-received. */
  let poVoidA = "";
  /** org A: ordered, delivered and billed all agree — must NOT appear. */
  let poCleanA = "";
  /** org B: over-billed by £9,000 — must NEVER appear in org A's queue. */
  let poOverB = "";

  /**
   * Raise an order with two lines: 10 @ £100 and 4 @ £50, both 20% VAT.
   * net £1,200 + VAT £240 = £1,440 gross.
   */
  async function mkOrder(org: string, number: string, status = "sent"): Promise<{ po: string; l1: string; l2: string }> {
    const po = await insId(svc, "purchase_orders", {
      org_id: org,
      number,
      status,
      subtotal: 1200,
      vat_total: 240,
    });
    const l1 = await insId(svc, "purchase_order_line_items", {
      org_id: org,
      purchase_order_id: po,
      description: "Concrete blocks",
      qty: 10,
      unit: "ea",
      unit_price: 100,
      vat_rate: 20,
      line_total: 1000,
      sort_order: 0,
    });
    const l2 = await insId(svc, "purchase_order_line_items", {
      org_id: org,
      purchase_order_id: po,
      description: "Sand",
      qty: 4,
      unit: "ea",
      unit_price: 50,
      vat_rate: 20,
      line_total: 200,
      sort_order: 1,
    });
    return { po, l1, l2 };
  }

  /** Record and POST a delivery — through the real born-draft-then-post lifecycle. */
  async function postDelivery(
    org: string,
    po: string,
    number: string,
    lines: Array<[string, number]>,
  ): Promise<string> {
    const grn = await insId(svc, "goods_received_notes", {
      org_id: org,
      purchase_order_id: po,
      number,
      delivery_date: "2026-06-01",
    });
    for (const [lineId, qty] of lines) {
      const r = await svc
        .from("goods_received_lines")
        .insert({
          org_id: org,
          goods_received_note_id: grn,
          purchase_order_line_item_id: lineId,
          qty_received: qty,
        });
      expect(r.error, `grn line: ${r.error?.message}`).toBeNull();
    }
    const posted = await svc.from("goods_received_notes").update({ status: "posted" }).eq("id", grn);
    expect(posted.error, `post: ${posted.error?.message}`).toBeNull();
    return grn;
  }

  async function mkBill(org: string, po: string | null, net: number, reference: string, supplier: string): Promise<string> {
    return insId(svc, "finances", {
      org_id: org,
      purchase_order_id: po,
      supplier_id: supplier,
      amount: net,
      vat_rate: 20,
      category: "Materials",
      reference,
      bill_date: "2026-06-10",
    });
  }

  /** The queue as the PAGE builds it: the dual user's JWT, pinned to one org. */
  const queueFor = (org: string) =>
    loadPoMatchingQueue(userClient(dual.token) as unknown as PoMatchingClient, org);

  let supA = "";
  let supB = "";

  beforeAll(async () => {
    orgA = await insId(svc, "organizations", { name: "3WM A", slug: `${TOKEN}-a` });
    orgB = await insId(svc, "organizations", { name: "3WM B", slug: `${TOKEN}-b` });
    dual = await mkUser("dual", [orgA, orgB]);
    supA = await insId(svc, "suppliers", { org_id: orgA, name: `${TOKEN} Merchant A` });
    supB = await insId(svc, "suppliers", { org_id: orgB, name: `${TOKEN} Merchant B` });

    // ── org A: over-billed by £120 ────────────────────────────────────────
    const over = await mkOrder(orgA, `${TOKEN}-A-OVER`);
    poOverA = over.po;
    await postDelivery(orgA, poOverA, `${TOKEN}-GRN-A1`, [[over.l1, 10], [over.l2, 4]]);
    await mkBill(orgA, poOverA, 1300, `${TOKEN}-INV-OVER`, supA); // £1,560 gross

    // ── org A: fully delivered, unbilled — a £1,440 accrual, across TWO notes ──
    const accrual = await mkOrder(orgA, `${TOKEN}-A-ACCRUAL`);
    poAccrualA = accrual.po;
    await postDelivery(orgA, poAccrualA, `${TOKEN}-GRN-A2`, [[accrual.l1, 4]]);
    await postDelivery(orgA, poAccrualA, `${TOKEN}-GRN-A3`, [[accrual.l1, 6], [accrual.l2, 4]]);

    // ── org A: delivered, VOIDED, and billed in full ──────────────────────
    const voided = await mkOrder(orgA, `${TOKEN}-A-VOID`);
    poVoidA = voided.po;
    const grnVoid = await postDelivery(orgA, poVoidA, `${TOKEN}-GRN-A4`, [
      [voided.l1, 10],
      [voided.l2, 4],
    ]);
    const v = await svc
      .from("goods_received_notes")
      .update({ status: "void", void_reason: "Wrong site — goods went back on the lorry" })
      .eq("id", grnVoid);
    expect(v.error, `void: ${v.error?.message}`).toBeNull();
    await mkBill(orgA, poVoidA, 1200, `${TOKEN}-INV-VOID`, supA); // £1,440 gross

    // ── org A: a clean order that must NOT be flagged ─────────────────────
    const clean = await mkOrder(orgA, `${TOKEN}-A-CLEAN`, "received");
    poCleanA = clean.po;
    await postDelivery(orgA, poCleanA, `${TOKEN}-GRN-A5`, [[clean.l1, 10], [clean.l2, 4]]);
    await mkBill(orgA, poCleanA, 1200, `${TOKEN}-INV-CLEAN`, supA); // £1,440 gross — exact

    // ── org A: a supplier bill with NO order behind it ────────────────────
    await mkBill(orgA, null, 250, `${TOKEN}-INV-ADHOC`, supA); // £300 gross

    // ── org B: over-billed by £9,000, the loudest row in the database ─────
    const overB = await mkOrder(orgB, `${TOKEN}-B-OVER`);
    poOverB = overB.po;
    await postDelivery(orgB, poOverB, `${TOKEN}-GRN-B1`, [[overB.l1, 10], [overB.l2, 4]]);
    await mkBill(orgB, poOverB, 8700, `${TOKEN}-INV-B-OVER`, supB); // £10,440 gross
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) if (id) await svc.from("organizations").delete().eq("id", id);
    if (dual.id) await serviceClient().auth.admin.deleteUser(dual.id);
  });

  // -------------------------------------------------------------------------
  // 1. THE DUAL-ORG PROOF
  // -------------------------------------------------------------------------

  it("org A's queue contains ONLY org A's orders", async () => {
    const q = await queueFor(orgA);
    const ids = q.discrepancies.map((d) => d.id);
    expect(ids).toContain(poOverA);
    expect(ids).toContain(poAccrualA);
    expect(ids).toContain(poVoidA);
    expect(ids, "org B's order surfaced in org A's queue").not.toContain(poOverB);
    expect(ids, "a fully matched order must not be flagged").not.toContain(poCleanA);
  });

  it("org B's queue contains ONLY org B's order", async () => {
    const q = await queueFor(orgB);
    const ids = q.discrepancies.map((d) => d.id);
    expect(ids).toContain(poOverB);
    for (const a of [poOverA, poAccrualA, poVoidA, poCleanA]) {
      expect(ids, "org A's order surfaced in org B's queue").not.toContain(a);
    }
  });

  it("org A's headline totals carry NONE of org B's money", async () => {
    const q = await queueFor(orgA);
    const rows = q.discrepancies.filter((d) => d.number.startsWith(TOKEN));
    // org A's own variances: £120 over-billed on one order, plus £1,440 billed
    // for the voided delivery, plus the same £120 counted as billed-not-received
    // on the over-billed order.
    const overBilled = rows.reduce(
      (t, r) => t + (r.match.findings.find((f) => f.kind === "over_billed")?.gross ?? 0),
      0,
    );
    expect(overBilled).toBe(120);
    expect(overBilled, "org B's £9,000 leaked into org A's total").not.toBe(9120);
  });

  it("org A's money-at-risk is double-count-free and carries none of org B's", async () => {
    const q = await queueFor(orgA);
    // org A's exposure: £120 over-billed on a fully delivered order (the same
    // £120 is ALSO flagged as billed-not-received — one variance, two angles),
    // plus £1,440 invoiced against a delivery that was voided. £1,560 total.
    expect(q.totals.moneyOutAtRisk).toBe(1560);
    // Adding the per-kind totals would say £1,680 — the £120 counted twice.
    expect(q.totals.overBilled + q.totals.billedNotReceived).toBe(1680);
    expect(q.totals.moneyOutAtRisk).toBeLessThan(
      q.totals.overBilled + q.totals.billedNotReceived,
    );
    // ...and the £1,440 accrual is money the company has NOT been asked for.
    expect(q.totals.receivedNotBilled).toBe(1440);

    const b = await queueFor(orgB);
    expect(b.totals.moneyOutAtRisk).toBe(9000);
  });

  it("the same order is classified identically no matter which org is asked", async () => {
    // Determinism across callers: A's over-billed row is £120 whether or not the
    // reader also belongs to B.
    const a = await queueFor(orgA);
    const row = a.discrepancies.find((d) => d.id === poOverA);
    expect(row?.match.state).toBe("over_billed");
    expect(row?.match.billedVsOrdered).toBe(120);
    expect(row?.match.ordered.gross).toBe(1440);
    expect(row?.match.received.gross).toBe(1440);
    expect(row?.match.billed.gross).toBe(1560);
  });

  it("unlinked supplier bills are org A's alone", async () => {
    const a = await queueFor(orgA);
    const mine = a.unlinkedBills.filter((b) => b.reference?.startsWith(TOKEN));
    expect(mine).toHaveLength(1);
    expect(mine[0]?.gross).toBe(300);

    const b = await queueFor(orgB);
    expect(b.unlinkedBills.filter((x) => x.reference?.startsWith(TOKEN))).toHaveLength(0);
  });

  it("the briefing signal is org-scoped too", async () => {
    const a = await loadSupplierBillVarianceSignal(
      userClient(dual.token) as unknown as PoMatchingClient,
      orgA,
    );
    const b = await loadSupplierBillVarianceSignal(
      userClient(dual.token) as unknown as PoMatchingClient,
      orgB,
    );
    expect(a.overBilled).toBe(120);
    expect(a.moneyOutAtRisk).toBe(1560);
    expect(b.overBilled).toBe(9000);
    expect(b.moneyOutAtRisk).toBe(9000);
  });

  // -------------------------------------------------------------------------
  // 2. THE PIN IS LOAD-BEARING
  // -------------------------------------------------------------------------

  it("without the pin, RLS alone hands the dual member BOTH companies", async () => {
    // The counterfactual. This is what the queue would be built from if
    // `.eq("org_id", orgId)` were dropped from pagedRows: the dual user's JWT
    // passes RLS for org A AND org B, so both companies' orders and both
    // companies' supplier bills come back in one result set.
    const rls = db(userClient(dual.token));

    const orders = await rls
      .from("purchase_orders")
      .select("id, org_id, number")
      .in("id", [poOverA, poOverB]);
    expect(orders.error, orders.error?.message).toBeNull();
    expect(
      (orders.data ?? []).length,
      "RLS admits both orgs — which is exactly why the pin exists",
    ).toBe(2);

    const pinned = await rls
      .from("purchase_orders")
      .select("id, org_id, number")
      .eq("org_id", orgA)
      .in("id", [poOverA, poOverB]);
    expect(pinned.error, pinned.error?.message).toBeNull();
    expect((pinned.data ?? []).length, "the pin must cut it to one").toBe(1);
    expect(String((pinned.data ?? [])[0]?.id)).toBe(poOverA);
  });

  // -------------------------------------------------------------------------
  // 3. A VOIDED DELIVERY, THROUGH THE REAL LIFECYCLE TRIGGER
  // -------------------------------------------------------------------------

  it("a voided delivery leaves no phantom goods — the order reads billed-not-received", async () => {
    const q = await queueFor(orgA);
    const row = q.discrepancies.find((d) => d.id === poVoidA);
    expect(row, "the voided-and-billed order must be flagged").toBeDefined();
    expect(row?.match.received.gross).toBe(0);
    expect(row?.match.postedGrnCount).toBe(0);
    expect(row?.match.voidedGrnCount).toBe(1);
    expect(row?.match.state).toBe("billed_not_received");
    expect(row?.match.findings[0]?.gross).toBe(1440);
    // The database really did refuse to keep it posted.
    const note = await svc
      .from("goods_received_notes")
      .select("status, void_reason")
      .eq("purchase_order_id", poVoidA)
      .maybeSingle();
    expect(note.data?.status).toBe("void");
    expect(String(note.data?.void_reason ?? "")).toContain("Wrong site");
  });

  it("a partial delivery split across two posted notes sums to the full accrual", async () => {
    const q = await queueFor(orgA);
    const row = q.discrepancies.find((d) => d.id === poAccrualA);
    expect(row?.match.postedGrnCount).toBe(2);
    expect(row?.match.receiptStatus).toBe("full");
    expect(row?.match.state).toBe("received_not_billed");
    expect(row?.match.accrual).toBe(1440);
    expect(row?.match.findings[0]?.net).toBe(1200);
    expect(row?.match.earliestPostedReceiptDate).toBe("2026-06-01");
  });

  // -------------------------------------------------------------------------
  // 4. READ-ONLY, PROVEN BY MUTATION COUNT
  // -------------------------------------------------------------------------

  it("building the queue writes NOTHING — no cost, no correction, no adjustment", async () => {
    const snapshot = async () => {
      const [fin, grn, po] = await Promise.all([
        svc.from("finances").select("id").eq("org_id", orgA),
        svc.from("goods_received_notes").select("id, status").eq("org_id", orgA),
        svc.from("purchase_orders").select("id, status").eq("org_id", orgA),
      ]);
      return JSON.stringify([
        (fin.data ?? []).length,
        (grn.data ?? []).map((g) => `${g.id}:${g.status}`).sort(),
        (po.data ?? []).map((p) => `${p.id}:${p.status}`).sort(),
      ]);
    };

    const before = await snapshot();
    await queueFor(orgA);
    await loadSupplierBillVarianceSignal(
      userClient(dual.token) as unknown as PoMatchingClient,
      orgA,
    );
    const after = await snapshot();

    // If detecting an over-billing ever posted a correction to `finances`, the
    // same spend would be counted twice against the same job. The queue tells a
    // human; a human rings the supplier.
    expect(after, "the matching read mutated state").toBe(before);
  });
});
