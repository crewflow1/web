import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient, userClient } from "../_harness";
import {
  gatherCustomerLtv,
  gatherProfitability,
  gatherSubcontractorScoreboard,
  type HealthClient,
} from "@/server/services/company-health";

/**
 * COMPANY HEALTH — active-org pinning against REAL Postgres.
 *
 * THE DEFECT THIS EXISTS TO PREVENT. `current_org_ids()` admits EVERY org the
 * viewer belongs to, which is correct for the outer RLS tenant boundary but does
 * NOT constrain a read to the ACTIVE org. Without an explicit `.eq("org_id", …)`
 * on every read, a dual-org owner viewing company A would see company A's
 * customer value, margin and subcontractor conduct BLENDED with company B's —
 * numbers about a named company, computed from another company's ledger.
 *
 * The fixtures make the two companies DELIBERATELY OPPOSITE so a blend cannot
 * hide in a plausible average:
 *
 *   customer value   A realised £1,000 + committed £500   ·  B realised £9,000
 *   margin           A 40% (1000 rev / 600 cost)          ·  B 5% (9000 / 8550)
 *   subcontractor    A one CIS sub, small over-bill        ·  B one CIS sub, huge
 *
 * If any pin were dropped, org A's figures would fold in org B's and this suite
 * goes red on the exact number a user would have been shown. The page calls these
 * SAME exported gather functions with a real client, so deleting an org pin fails
 * HERE, not just in review.
 *
 * Residue-independent: fixtures are namespaced by a per-run TOKEN and every
 * assertion is made against ids created by THIS run.
 */

type Row = Record<string, unknown>;
type Res<T> = { data: T | null; error: { message: string } | null };
interface Ins extends PromiseLike<Res<Row[]>> {
  select(columns?: string): { single(): PromiseLike<Res<Row>> };
}
interface Del {
  eq(column: string, value: unknown): PromiseLike<Res<null>>;
}
interface Upd extends PromiseLike<Res<Row[]>> {
  eq(column: string, value: unknown): Upd;
}
interface Table {
  insert(rows: Row | Row[]): Ins;
  update(row: Row): Upd;
  delete(): Del;
}
const db = (client: unknown) => client as unknown as { from(t: string): Table };

const TOKEN = `it-health-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function insId(svc: ReturnType<typeof db>, table: string, row: Row): Promise<string> {
  const res = await svc.from(table).insert(row).select("id").single();
  expect(res.error, `${table}: ${res.error?.message}`).toBeNull();
  const id = String(res.data?.id ?? "");
  if (!id) throw new Error(`failed to insert into ${table}`);
  return id;
}

/** cis_subcontractors has a composite PK (org_id, supplier_id) — no `id`. */
async function insRow(svc: ReturnType<typeof db>, table: string, row: Row): Promise<void> {
  const res = await svc.from(table).insert(row);
  expect(res.error, `${table}: ${res.error?.message}`).toBeNull();
}

async function mkUser(suffix: string, orgIds: string[]): Promise<{ id: string; token: string }> {
  const email = `${TOKEN}-${suffix}@example.test`;
  const password = `Pw-${TOKEN}-${Math.random().toString(36).slice(2)}`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  expect(created.error, created.error?.message).toBeNull();
  const id = created.data.user?.id ?? "";
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

describeIntegration("company health · active-org pinning (RLS)", () => {
  const svc = db(serviceClient());

  let orgA = "";
  let orgB = "";
  let dual = { id: "", token: "" };
  let outsider = { id: "", token: "" };
  let supplierA = "";
  let supplierB = "";

  /** A PO + one line + a POSTED goods received note, through the real lifecycle. */
  async function order(opts: {
    orgId: string;
    supplierId: string;
    seq: number;
    delivered: string;
    expected: string;
    subtotal?: number;
  }): Promise<string> {
    const poId = await insId(svc, "purchase_orders", {
      org_id: opts.orgId,
      supplier_id: opts.supplierId,
      number: `PO-${TOKEN}-${opts.seq}`,
      status: "sent",
      expected_date: opts.expected,
      subtotal: opts.subtotal ?? 100,
      vat_total: 20,
    });
    const lineId = await insId(svc, "purchase_order_line_items", {
      org_id: opts.orgId,
      purchase_order_id: poId,
      description: "Labour",
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
    return poId;
  }

  beforeAll(async () => {
    orgA = await insId(svc, "organizations", { name: "Health A", slug: `${TOKEN}-a` });
    orgB = await insId(svc, "organizations", { name: "Health B", slug: `${TOKEN}-b` });
    dual = await mkUser("dual", [orgA, orgB]);
    outsider = await mkUser("outsider", [orgB]);

    // ── Customers (same name in each org) + invoices for customer value ───────
    const custA = await insId(svc, "customers", { org_id: orgA, name: `${TOKEN} Shared Customer` });
    const custB = await insId(svc, "customers", { org_id: orgB, name: `${TOKEN} Shared Customer` });

    // ── Profitability jobs + revenue/cost ────────────────────────────────────
    const jobA = await insId(svc, "jobs", { org_id: orgA, customer_id: custA });
    const jobB = await insId(svc, "jobs", { org_id: orgB, customer_id: custB });

    // Org A: paid £1,000 (revenue for jobA) + a separate sent £500 (committed, no job).
    await insRow(svc, "invoices", {
      org_id: orgA,
      number: `INV-${TOKEN}-A1`,
      status: "paid",
      amount: 1000,
      customer_id: custA,
      job_id: jobA,
    });
    await insRow(svc, "invoices", {
      org_id: orgA,
      number: `INV-${TOKEN}-A2`,
      status: "sent",
      amount: 500,
      customer_id: custA,
      job_id: null,
    });
    await insRow(svc, "finances", { org_id: orgA, job_id: jobA, amount: 600, category: "materials" });

    // Org B: paid £9,000 (revenue for jobB), £8,550 cost → 5% margin.
    await insRow(svc, "invoices", {
      org_id: orgB,
      number: `INV-${TOKEN}-B1`,
      status: "paid",
      amount: 9000,
      customer_id: custB,
      job_id: jobB,
    });
    await insRow(svc, "finances", { org_id: orgB, job_id: jobB, amount: 8550, category: "materials" });

    // ── CIS subcontractors (a supplier + a cis profile per org) ───────────────
    supplierA = await insId(svc, "suppliers", { org_id: orgA, name: `${TOKEN} Sub A`, category: "Groundworks" });
    supplierB = await insId(svc, "suppliers", { org_id: orgB, name: `${TOKEN} Sub B`, category: "Groundworks" });
    await insRow(svc, "cis_subcontractors", {
      org_id: orgA,
      supplier_id: supplierA,
      legal_name: `${TOKEN} Sub A Ltd`,
    });
    await insRow(svc, "cis_subcontractors", {
      org_id: orgB,
      supplier_id: supplierB,
      legal_name: `${TOKEN} Sub B Ltd`,
    });

    // Org A sub: one early delivery + one bill £240 gross over a £120 order (£120 excess).
    const aPo = await order({
      orgId: orgA,
      supplierId: supplierA,
      seq: 1,
      delivered: "2026-06-09",
      expected: "2026-06-10",
      subtotal: 100,
    });
    await insRow(svc, "finances", {
      org_id: orgA,
      supplier_id: supplierA,
      purchase_order_id: aPo,
      amount: 200,
      vat_rate: 20,
      category: "subcontractors",
      bill_date: "2026-06-15",
      reference: `${TOKEN}-A-BILL`,
    });

    // Org B sub: one 50-days-late delivery + a bill £6,000 gross over £120 (£5,880 excess).
    const bPo = await order({
      orgId: orgB,
      supplierId: supplierB,
      seq: 2,
      delivered: "2026-07-30",
      expected: "2026-06-10",
      subtotal: 100,
    });
    await insRow(svc, "finances", {
      org_id: orgB,
      supplier_id: supplierB,
      purchase_order_id: bPo,
      amount: 5000,
      vat_rate: 20,
      category: "subcontractors",
      bill_date: "2026-06-15",
      reference: `${TOKEN}-B-BILL`,
    });
  });

  afterAll(async () => {
    for (const org of [orgA, orgB]) if (org) await svc.from("organizations").delete().eq("id", org);
    for (const u of [dual, outsider]) {
      if (u.id) {
        await svc.from("users").delete().eq("id", u.id);
        await serviceClient().auth.admin.deleteUser(u.id);
      }
    }
  });

  // -------------------------------------------------------------------------
  // Customer lifetime value
  // -------------------------------------------------------------------------

  it("computes org A's customer value from org A's invoices ONLY", async () => {
    const client = userClient(dual.token) as unknown as HealthClient;
    const l = await gatherCustomerLtv(client, orgA);
    // THE FIGURES A BLEND WOULD BREAK: org B's £9,000 must be invisible here.
    expect(l.realisedTotal).toBe(1000);
    expect(l.committedTotal).toBe(500);
    expect(l.invoiceCount).toBe(2);
    expect(l.realisedTotal).not.toBe(10000);
  });

  it("computes org B's customer value from org B's invoices ONLY", async () => {
    const client = userClient(dual.token) as unknown as HealthClient;
    const l = await gatherCustomerLtv(client, orgB);
    expect(l.realisedTotal).toBe(9000);
    expect(l.committedTotal).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Profitability
  // -------------------------------------------------------------------------

  it("computes org A's margin from org A's ledger ONLY", async () => {
    const client = userClient(dual.token) as unknown as HealthClient;
    const rows = await gatherProfitability(client, orgA);
    // Only jobA has revenue in org A (the £500 sent invoice has no job).
    const withRevenue = rows.filter((r) => r.margin_pct !== null);
    expect(withRevenue).toHaveLength(1);
    expect(withRevenue[0]!.margin_pct).toBe(40);
    // A blend would introduce org B's 5% job and pull the set to two rows.
    expect(withRevenue.some((r) => r.margin_pct === 5)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Subcontractor scoreboard
  // -------------------------------------------------------------------------

  it("scores org A's CIS subcontractors ONLY (roster is org-pinned)", async () => {
    const client = userClient(dual.token) as unknown as HealthClient;
    const board = await gatherSubcontractorScoreboard(client, orgA);
    // If the roster read were unpinned, the dual owner would pull org B's CIS
    // sub too and this would be 2.
    expect(board.subcontractorsConsidered).toBe(1);
    expect(board.subcontractorsWithRecord).toBe(1);
    const row = board.rows[0]!;
    expect(row.supplierId).toBe(supplierA);
    expect(row.deliveries).toBe(1);
    // Org A's over-billing excess is £120 — never org B's £5,880.
    expect(row.overBilledExcess).toBe(120);
    expect(row.overBilledExcess).not.toBe(5880);
  });

  it("scores org B's CIS subcontractors from org B's history ONLY", async () => {
    const client = userClient(dual.token) as unknown as HealthClient;
    const board = await gatherSubcontractorScoreboard(client, orgB);
    expect(board.subcontractorsConsidered).toBe(1);
    expect(board.rows[0]!.overBilledExcess).toBe(5880);
    expect(board.rows[0]!.punctuality.count).toBe(1); // the one late delivery
  });

  // -------------------------------------------------------------------------
  // RLS is still the outer boundary
  // -------------------------------------------------------------------------

  it("gives a member of only org B nothing for org A", async () => {
    const client = userClient(outsider.token) as unknown as HealthClient;
    const l = await gatherCustomerLtv(client, orgA);
    expect(l.realisedTotal).toBe(0);
    expect(l.committedTotal).toBe(0);
    const rows = await gatherProfitability(client, orgA);
    expect(rows.filter((r) => r.margin_pct !== null)).toHaveLength(0);
    const board = await gatherSubcontractorScoreboard(client, orgA);
    expect(board.subcontractorsConsidered).toBe(0);
  });
});
