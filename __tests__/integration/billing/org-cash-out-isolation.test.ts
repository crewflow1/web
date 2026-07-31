import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import { gatherCashOutFacts, type CashOutClient } from "@/server/services/org-cash-out";
import { computeCashPosition, computeOrgCashOut } from "@/lib/commercial/cash-out";
import { startOfQuarterIso } from "@/lib/tax/compute";

/**
 * H2-CASH M4 — the money-OUT side of /cash against REAL Postgres.
 *
 * The proof that matters here is the DUAL-ORG one. Every table this surface
 * reads is admitted by RLS for EVERY org the viewer belongs to
 * (`current_org_ids()` / `is_org_admin` are both many-to-many over memberships),
 * so RLS alone BLENDS two companies. On a money page that means one company's
 * payables, CIS liability and VAT estimate added to another's — and a net
 * position that describes neither business. `gatherCashOutFacts`' explicit
 * `org_id` pin is what prevents it, and this file drives the EXACT production
 * query path with a real dual-org user's JWT to prove the pin is load-bearing.
 *
 * It also proves the two things the unit tier cannot:
 *   · that the money-out reads actually resolve against the live schema (column
 *     names, the composite-key snapshot table, the generated `vat_total`);
 *   · that a non-member and anon see nothing.
 */

type Res = { data: Array<Record<string, unknown>> | null; error: unknown };
interface Sel extends PromiseLike<Res> {
  eq(c: string, v: unknown): Sel;
  select(c: string): Sel;
}
const db = (c: unknown) =>
  c as unknown as {
    from(t: string): {
      select(c: string): Sel;
      insert(r: Record<string, unknown>): { select(c: string): { single(): PromiseLike<{ data: { id: string } | null; error: unknown }> } };
    };
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  };

const T = `it-cashout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const TODAY = new Date().toISOString().slice(0, 10);

describeIntegration("H2-CASH money-out isolation + composition (real Postgres)", () => {
  let orgA = "";
  let orgB = "";
  let supA = "";
  let supB = "";
  let billA1 = "";
  let billA2 = "";
  let poA = "";
  let outsider = { id: "", token: "" };
  let dual = { id: "", token: "" };
  let adminA = { id: "", token: "" };
  const svc = () => db(serviceClient());

  async function newUser(label: string, orgs: string[]) {
    const email = `${T}-${label}@x.test`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password: `Pw-${T}`,
      email_confirm: true,
    });
    const id = created.data.user?.id ?? "";
    await svc().from("users").insert({ id, email, full_name: label });
    for (const org of orgs) {
      await svc().from("memberships").insert({ org_id: org, user_id: id, role: "admin" });
    }
    const s = await anonClient().auth.signInWithPassword({ email, password: `Pw-${T}` });
    return { id, token: s.data.session?.access_token ?? "" };
  }

  beforeAll(async () => {
    orgA = String((await svc().from("organizations").insert({ name: "CO A", slug: `${T}-a` }).select("id").single()).data?.id);
    orgB = String((await svc().from("organizations").insert({ name: "CO B", slug: `${T}-b` }).select("id").single()).data?.id);

    supA = String((await svc().from("suppliers").insert({ org_id: orgA, name: `Merchant A ${T}` }).select("id").single()).data?.id);
    supB = String((await svc().from("suppliers").insert({ org_id: orgB, name: `Merchant B ${T}` }).select("id").single()).data?.id);

    // ── ORG A money-out fixtures ───────────────────────────────────────────
    // Bill 1: £1,000 net + 20% VAT = £1,200 gross. Unpaid.
    billA1 = String(
      (
        await svc()
          .from("finances")
          .insert({ org_id: orgA, supplier_id: supA, amount: 1000, vat_rate: 20, category: "materials", reference: `${T}-B1` })
          .select("id")
          .single()
      ).data?.id,
    );
    // A purchase order for £2,400 gross, PART billed by bill 2 (£600 gross) —
    // the double-count precedence case.
    poA = String(
      (
        await svc()
          .from("purchase_orders")
          .insert({ org_id: orgA, supplier_id: supA, number: `${T}-PO1`, status: "sent", subtotal: 2000, vat_total: 400 })
          .select("id")
          .single()
      ).data?.id,
    );
    billA2 = String(
      (
        await svc()
          .from("finances")
          .insert({ org_id: orgA, supplier_id: supA, purchase_order_id: poA, amount: 500, vat_rate: 20, category: "materials", reference: `${T}-B2` })
          .select("id")
          .single()
      ).data?.id,
    );
    // A draft payroll run with one line (net pay £800) → the payroll estimate.
    const runA = String(
      (
        await svc()
          .from("payroll_runs")
          .insert({ org_id: orgA, cycle: "weekly", period_start: "2026-07-20", period_end: "2026-07-26", status: "draft" })
          .select("id")
          .single()
      ).data?.id,
    );
    // A paid invoice this quarter → output VAT for the VAT estimate.
    await svc()
      .from("invoices")
      .insert({ org_id: orgA, number: `${T}-INVA`, amount: 5000, vat_total: 1000, status: "paid", paid_at: TODAY });

    // ── ORG B money-out fixtures (must NEVER appear in org A's position) ────
    await svc()
      .from("finances")
      .insert({ org_id: orgB, supplier_id: supB, amount: 90_000, vat_rate: 20, category: "materials", reference: `${T}-BB` });
    await svc()
      .from("purchase_orders")
      .insert({ org_id: orgB, supplier_id: supB, number: `${T}-POB`, status: "sent", subtotal: 70_000, vat_total: 14_000 });
    await svc()
      .from("invoices")
      .insert({ org_id: orgB, number: `${T}-INVB`, amount: 50_000, vat_total: 10_000, status: "paid", paid_at: TODAY });

    outsider = await newUser("out", [orgB]);
    dual = await newUser("dual", [orgA, orgB]);
    adminA = await newUser("adminA", [orgA]);

    // A payroll line needs a user in the org — reuse admin A.
    await svc().from("payroll_lines").insert({
      org_id: orgA,
      payroll_run_id: runA,
      user_id: adminA.id,
      hours: 40,
      hourly_pay: 25,
      gross_pay: 1000,
      paye_estimate: 150,
      ni_estimate: 50,
      net_pay: 800,
    });
  });

  afterAll(async () => {
    const s = serviceClient() as unknown as {
      from(t: string): { delete(): { eq(c: string, v: unknown): PromiseLike<Res> } };
    };
    if (orgA) await s.from("organizations").delete().eq("id", orgA);
    if (orgB) await s.from("organizations").delete().eq("id", orgB);
    for (const u of [outsider, dual, adminA]) {
      if (u.id) await serviceClient().auth.admin.deleteUser(u.id);
    }
  });

  // -------------------------------------------------------------------------
  // 1. The dual-org proof — the org_id pin is load-bearing, not decoration
  // -------------------------------------------------------------------------

  it("[P0] RLS alone BLENDS both orgs' payables and orders for a dual-org member", async () => {
    const asDual = db(userClient(dual.token));
    // Both tables carry a row in EACH test org, so "both org ids come back" is a
    // real demonstration of blending rather than an artefact of one-sided data.
    for (const table of ["finances", "purchase_orders"]) {
      const rows = (await asDual.from(table).select("org_id")).data ?? [];
      const orgs = new Set(rows.map((r) => String(r.org_id)));
      expect(
        orgs.has(orgA) && orgs.has(orgB),
        `${table}: RLS admits every org the viewer belongs to`,
      ).toBe(true);
    }
  });

  it("[P0] gatherCashOutFacts pins to the ACTIVE org — org B's £90k bill never lands in A's position", async () => {
    const asDual = userClient(dual.token) as unknown as CashOutClient;
    const facts = await gatherCashOutFacts(asDual, orgA, TODAY);
    expect(facts.failed, "no read errored").toBe(false);

    // Only org A's bills came back.
    const billIds = new Set(facts.bills.map((b) => b.id));
    expect(billIds.has(billA1)).toBe(true);
    expect(billIds.has(billA2)).toBe(true);
    expect(facts.bills.every((b) => b.supplier_id === supA), "no org B supplier").toBe(true);
    expect(facts.purchaseOrders.every((p) => p.supplier_id === supA || p.supplier_id === null)).toBe(true);

    const summary = computeOrgCashOut({
      bills: facts.bills,
      payments: facts.payments,
      allocations: facts.allocations,
      purchaseOrders: facts.purchaseOrders,
      payrollRuns: facts.payrollRuns,
      payrollLines: facts.payrollLines,
      cisSnapshots: facts.cisSnapshots,
      vatInvoices: facts.invoices,
      vatFinances: facts.allFinances,
      quarterStartIso: startOfQuarterIso(new Date()),
      todayIso: TODAY,
    });

    // Org A only: £1,200 (bill 1) + £600 (bill 2) = £1,800 outstanding.
    expect(summary.unpaidBills).toBe(1800);
    // Org B's £108,000 bill is nowhere near the figure.
    expect(summary.unpaidBills).toBeLessThan(2000);
    // Draft payroll is org A's £800, not org B's (which has none).
    expect(summary.payrollDraft).toBe(800);
    expect(summary.payrollDraftRunCount).toBe(1);
  });

  it("[P0] the SAME reads against org B give org B's figures — one code path, two answers", async () => {
    const asDual = userClient(dual.token) as unknown as CashOutClient;
    const facts = await gatherCashOutFacts(asDual, orgB, TODAY);
    expect(facts.failed).toBe(false);
    const summary = computeOrgCashOut({
      bills: facts.bills,
      payments: facts.payments,
      allocations: facts.allocations,
      purchaseOrders: facts.purchaseOrders,
      payrollRuns: facts.payrollRuns,
      payrollLines: facts.payrollLines,
      cisSnapshots: facts.cisSnapshots,
      vatInvoices: facts.invoices,
      vatFinances: facts.allFinances,
      quarterStartIso: startOfQuarterIso(new Date()),
      todayIso: TODAY,
    });
    // £90,000 net + £18,000 VAT = £108,000 gross, unpaid.
    expect(summary.unpaidBills).toBe(108_000);
    expect(summary.payrollDraft).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 2. The precedence, against the live generated columns
  // -------------------------------------------------------------------------

  it("a PART-billed PO commits only the un-invoiced remainder (bills take precedence)", async () => {
    const asA = userClient(adminA.token) as unknown as CashOutClient;
    const facts = await gatherCashOutFacts(asA, orgA, TODAY);
    const summary = computeOrgCashOut({
      bills: facts.bills,
      payments: facts.payments,
      allocations: facts.allocations,
      purchaseOrders: facts.purchaseOrders,
      payrollRuns: facts.payrollRuns,
      payrollLines: facts.payrollLines,
      cisSnapshots: facts.cisSnapshots,
      vatInvoices: facts.invoices,
      vatFinances: facts.allFinances,
      quarterStartIso: startOfQuarterIso(new Date()),
      todayIso: TODAY,
    });
    // PO = £2,400 gross (generated: subtotal + vat_total). Bill 2 has invoiced
    // £600 of it, so £1,800 is still committed and NOT double-counted.
    expect(summary.committedNotBilled).toBe(1800);
    expect(summary.committedPoCount).toBe(1);
    // The bill's £600 lives in unpaidBills. Together they equal the order.
    expect(summary.committedNotBilled + 600).toBe(2400);
    // The gross commitment authority still reports the whole order.
    expect(summary.committed.committed).toBe(2400);
    expect(summary.committed.onOrder).toBe(2400);
    // Committed spend stays OUT of the position.
    expect(summary.outflowDueNow).toBe(
      Math.round((summary.unpaidBills + summary.cisDueNow + summary.vatDue + summary.payrollDraft) * 100) / 100,
    );
  });

  it("the live generated vat_total drives the bill gross (VAT is not re-derived in TS)", async () => {
    const asA = userClient(adminA.token) as unknown as CashOutClient;
    const facts = await gatherCashOutFacts(asA, orgA, TODAY);
    const b1 = facts.bills.find((b) => b.id === billA1);
    // `finances.vat_total` is `round(amount * vat_rate / 100, 2)` STORED — the
    // database computed the £200, not this code.
    expect(Number(b1?.vat_total)).toBe(200);
  });

  it("a settled bill leaves the payables total (the allocation ledger is live)", async () => {
    // Record a real payment through the RPC so the DB's own guards apply, then
    // re-read: the £1,200 bill must drop out of the payables figure entirely.
    const asA = db(userClient(adminA.token));
    const paid = await asA.rpc("record_supplier_payment", {
      p_org_id: orgA,
      p_supplier_id: supA,
      p_paid_at: TODAY,
      p_method: "bank_transfer",
      p_gross_amount: 1200,
      p_cis_withheld: 0,
      p_reference: `${T}-PAY`,
      p_notes: null,
      p_allocations: [{ finance_id: billA1, amount: 1200 }],
    });
    // If the RPC signature differs in this schema version the test must say so
    // rather than silently assert nothing.
    expect(paid.error?.message ?? null, "record_supplier_payment should accept the draft").toBeNull();

    const facts = await gatherCashOutFacts(userClient(adminA.token) as unknown as CashOutClient, orgA, TODAY);
    const summary = computeOrgCashOut({
      bills: facts.bills,
      payments: facts.payments,
      allocations: facts.allocations,
      purchaseOrders: facts.purchaseOrders,
      payrollRuns: facts.payrollRuns,
      payrollLines: facts.payrollLines,
      cisSnapshots: facts.cisSnapshots,
      vatInvoices: facts.invoices,
      vatFinances: facts.allFinances,
      quarterStartIso: startOfQuarterIso(new Date()),
      todayIso: TODAY,
    });
    expect(summary.unpaidBills).toBe(600); // only bill 2 remains
    expect(summary.billsSettled).toBe(1200);
  });

  // -------------------------------------------------------------------------
  // 3. Outsiders and anon see nothing
  // -------------------------------------------------------------------------

  it("a member of another org sees NONE of org A's money-out rows", async () => {
    const asOut = db(userClient(outsider.token));
    for (const table of ["finances", "purchase_orders", "payroll_runs", "payroll_lines", "supplier_payments"]) {
      const rows = (await asOut.from(table).select("id").eq("org_id", orgA)).data ?? [];
      expect(rows.length, `${table} must be empty for an outsider`).toBe(0);
    }
  });

  it("an outsider driving the production read path gets an EMPTY position, not org A's", async () => {
    const facts = await gatherCashOutFacts(
      userClient(outsider.token) as unknown as CashOutClient,
      orgA,
      TODAY,
    );
    const summary = computeOrgCashOut({
      bills: facts.bills,
      payments: facts.payments,
      allocations: facts.allocations,
      purchaseOrders: facts.purchaseOrders,
      payrollRuns: facts.payrollRuns,
      payrollLines: facts.payrollLines,
      cisSnapshots: facts.cisSnapshots,
      vatInvoices: facts.invoices,
      vatFinances: facts.allFinances,
      quarterStartIso: startOfQuarterIso(new Date()),
      todayIso: TODAY,
    });
    expect(summary.unpaidBills).toBe(0);
    expect(summary.committedNotBilled).toBe(0);
    expect(summary.payrollDraft).toBe(0);
    const position = computeCashPosition({
      collectableNow: 0,
      outflowDueNow: summary.outflowDueNow,
      estimatedOutflow: summary.outflowEstimated,
    });
    expect(position.net).toBe(0);
  });

  it("anon sees none of the money-out surface", async () => {
    const asAnon = db(anonClient());
    for (const table of ["finances", "purchase_orders", "payroll_lines", "supplier_payments", "cis_payment_snapshots"]) {
      const rows = (await asAnon.from(table).select("org_id").eq("org_id", orgA)).data ?? [];
      expect(rows.length, `${table} must be empty for anon`).toBe(0);
    }
  });
});
