import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import { computeJobProfitability } from "@/lib/profitability/compute";
import { computeVatQuarter } from "@/lib/tax/compute";
import { cisTaxMonth } from "@/lib/cis/tax-month";

/**
 * H2-CIS M3 — the deduction engine + reverse charge, against REAL Postgres
 * (20261051000000).
 *
 * Tax rules verified against HMRC guidance on 27 July 2026 — docs/cis-domain.md.
 * The properties under test are the ones that make a tax engine trustworthy
 * rather than merely functional:
 *
 *   1. AUTHORITY     — the rate comes from HMRC verification, never the client.
 *                      A forged rate, basis or deduction is REFUSED even on the
 *                      service_role path that bypasses RLS entirely.
 *   2. ARITHMETIC    — penny-exact across partial payments, with no drift, no
 *                      double material allowance and no double deduction.
 *   3. IMMUTABILITY  — a posted payment's tax facts never move, including after
 *                      the subcontractor is re-verified at a different rate.
 *   4. REVERSE CHARGE— modelled as a treatment with a real rate and amount, and
 *                      existing VAT reporting is byte-identical.
 *   5. THE INVARIANT — job cost and profitability do not move by a penny.
 *
 * Fixtures are tagged with a per-run TOKEN so the suite is residue-independent.
 */

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };
type Row = Record<string, unknown>;
interface Sel extends PromiseLike<Res<Row[]>> {
  eq(c: string, v: unknown): Sel;
  order(c: string, o?: { ascending?: boolean }): Sel;
  maybeSingle(): PromiseLike<Res<Row>>;
}
interface Upd extends PromiseLike<Res<null>> {
  eq(c: string, v: unknown): Upd;
}
interface Ins extends PromiseLike<Res<Row[]>> {
  select(c?: string): { single(): PromiseLike<Res<Row>>; maybeSingle(): PromiseLike<Res<Row>> };
}
interface Del extends PromiseLike<Res<null>> {
  eq(c: string, v: unknown): Del;
}
interface Table {
  select(c?: string): Sel;
  insert(r: Row): Ins;
  update(v: Row): Upd;
  delete(): Del;
  upsert(r: Row, o?: { onConflict?: string }): PromiseLike<Res<null>>;
}
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<Res<unknown>>;
const db = (c: unknown) => c as unknown as { from(t: string): Table; rpc: Rpc };

const T = `it-cism3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const num = (v: unknown): number => Number(v ?? 0);
const p2 = (n: number): number => Math.round(n * 100) / 100;

describeIntegration("H2-CIS M3 deduction engine (real Postgres)", () => {
  let orgA = "";
  let orgB = "";
  let sub20 = ""; // orgA, verified standard_20
  let sub30 = ""; // orgA, higher_30
  let subGross = ""; // orgA, gross payment status
  let subUnver = ""; // orgA, CIS profile but unverified
  let merch = ""; // orgA, NOT a CIS subcontractor
  let subB = ""; // orgB
  let jobA = "";
  let admin = { id: "", token: "" };
  let member = { id: "", token: "" };
  let adminB = { id: "", token: "" };

  const svc = () => db(serviceClient());
  const asAdmin = () => db(userClient(admin.token));
  const asMember = () => db(userClient(member.token));
  const asAdminB = () => db(userClient(adminB.token));

  async function mkMember(orgId: string, role: string, tag: string) {
    const email = `${T}-${tag}@x.test`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password: `Pw-${T}`,
      email_confirm: true,
    });
    if (created.error) throw new Error(created.error.message);
    const id = created.data.user?.id ?? "";
    await svc().from("users").insert({ id, email, full_name: tag });
    await svc().from("memberships").insert({ org_id: orgId, user_id: id, role });
    const s = await anonClient().auth.signInWithPassword({ email, password: `Pw-${T}` });
    if (s.error) throw new Error(s.error.message);
    return { id, token: s.data.session?.access_token ?? "" };
  }

  async function mkSupplier(org: string, name: string) {
    const r = await svc()
      .from("suppliers")
      .insert({ org_id: org, name: `${T} ${name}` })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function mkCis(org: string, supplier: string, status: string, name: string) {
    const outcome = ["gross", "standard_20", "higher_30", "failed"].includes(status);
    const r = await svc().from("cis_subcontractors").insert({
      org_id: org,
      supplier_id: supplier,
      legal_name: `${name} Ltd`,
      utr: "1234567890",
      cis_status: status,
      verified_at: outcome ? "2026-06-01" : null,
      verification_reference: outcome ? "V1234567890" : null,
    });
    expect(r.error, r.error?.message).toBeNull();
  }

  async function mkBill(
    org: string,
    supplier: string | null,
    amount: number,
    vatRate: number,
    job?: string,
  ) {
    const r = await svc()
      .from("finances")
      .insert({
        org_id: org,
        supplier_id: supplier,
        amount,
        vat_rate: vatRate,
        category: "subcontractor",
        job_id: job ?? null,
        reference: `${T}-bill`,
      })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  async function setDetails(
    org: string,
    supplier: string,
    finance: string,
    d: {
      materials?: number;
      citb?: number;
      treatment?: "standard" | "reverse_charge";
      rcRate?: number | null;
    },
  ) {
    return svc()
      .from("cis_bill_details")
      .upsert(
        {
          org_id: org,
          finance_id: finance,
          supplier_id: supplier,
          materials_amount: d.materials ?? 0,
          citb_levy_amount: d.citb ?? 0,
          vat_treatment: d.treatment ?? "standard",
          reverse_charge_vat_rate: d.rcRate ?? null,
        },
        { onConflict: "org_id,finance_id" },
      );
  }

  /** Post a CIS payment through the RPC as the org admin. */
  async function post(
    client: ReturnType<typeof db>,
    org: string,
    supplier: string,
    lines: Array<{ finance_id: string; amount: number }>,
    opts: { paidAt?: string; ref?: string; expectedRate?: number | null } = {},
  ) {
    return client.rpc("record_cis_supplier_payment", {
      p_org_id: org,
      p_supplier_id: supplier,
      p_paid_at: opts.paidAt ?? "2026-07-01",
      p_method: "bank_transfer",
      p_reference: opts.ref ?? null,
      p_notes: null,
      p_allocations: lines,
      p_expected_rate: opts.expectedRate ?? null,
    });
  }

  async function paymentRow(id: string) {
    const r = await svc()
      .from("supplier_payments")
      .select("gross_amount, cis_withheld, net_paid, voided_at")
      .eq("id", id)
      .maybeSingle();
    return r.data ?? {};
  }

  async function snapshotRow(id: string) {
    const r = await svc()
      .from("cis_payment_snapshots")
      .select(
        "cis_status, deduction_rate, cis_gross_payment, materials_total, citb_total, " +
          "cis_basis, cis_deduction, tax_month_start, tax_month_end, utr_masked, legal_name",
      )
      .eq("payment_id", id)
      .maybeSingle();
    return r.data ?? {};
  }

  async function allocsFor(financeId: string) {
    const r = await svc()
      .from("supplier_payment_allocations")
      .select("amount, cis_basis, cis_deduction, cis_rate_applied, cis_reverse_charge_vat, payment_id")
      .eq("finance_id", financeId)
      .order("created_at", { ascending: true });
    return r.data ?? [];
  }

  beforeAll(async () => {
    orgA = String(
      (await svc().from("organizations").insert({ name: "M3 A", slug: `${T}-a` }).select("id").single())
        .data?.id,
    );
    orgB = String(
      (await svc().from("organizations").insert({ name: "M3 B", slug: `${T}-b` }).select("id").single())
        .data?.id,
    );

    sub20 = await mkSupplier(orgA, "Groundworks");
    sub30 = await mkSupplier(orgA, "Roofing");
    subGross = await mkSupplier(orgA, "Steelwork");
    subUnver = await mkSupplier(orgA, "Unverified");
    merch = await mkSupplier(orgA, "Merchant");
    subB = await mkSupplier(orgB, "OtherOrg");

    await mkCis(orgA, sub20, "standard_20", "Groundworks");
    await mkCis(orgA, sub30, "higher_30", "Roofing");
    await mkCis(orgA, subGross, "gross", "Steelwork");
    await mkCis(orgA, subUnver, "unverified", "Unverified");
    await mkCis(orgB, subB, "standard_20", "OtherOrg");
    // `merch` deliberately gets NO cis_subcontractors row.

    jobA = String(
      (await svc().from("jobs").insert({ org_id: orgA, notes: `${T} Job` }).select("id").single()).data
        ?.id,
    );

    admin = await mkMember(orgA, "admin", "adm");
    member = await mkMember(orgA, "staff", "mem");
    adminB = await mkMember(orgB, "admin", "admb");
  });

  afterAll(async () => {
    // NOTE: `delete from organizations` currently FAILS for any org holding a
    // `finances` row — a pre-existing defect in `_tg_finances_activity` (it logs
    // to `activity_log` after the org row is gone), documented in M2's suite and
    // unrelated to this milestone. Fixtures are TOKEN-tagged precisely so
    // leftover rows cannot affect a later run.
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (orgB) await svc().from("organizations").delete().eq("id", orgB);
    for (const m of [admin, member, adminB]) {
      if (m.id) await serviceClient().auth.admin.deleteUser(m.id);
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 1. THE RATES
  // ═════════════════════════════════════════════════════════════════════════

  it("standard rate: 10,000 bill with 3,000 materials deducts 1,400, not 2,000", async () => {
    const bill = await mkBill(orgA, sub20, 10_000, 0, jobA);
    await setDetails(orgA, sub20, bill, { materials: 3_000 });

    const r = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 10_000 }], {
      expectedRate: 20,
    });
    expect(r.error, r.error?.message).toBeNull();
    const id = String(r.data);

    const pay = await paymentRow(id);
    expect(num(pay.gross_amount)).toBe(10_000);
    expect(num(pay.cis_withheld)).toBe(1_400); // 7,000 labour x 20%
    expect(num(pay.net_paid)).toBe(8_600);

    // NOT bill x rate — that would be 2,000.
    expect(num(pay.cis_withheld)).not.toBe(2_000);

    const snap = await snapshotRow(id);
    expect(num(snap.cis_basis)).toBe(7_000);
    expect(num(snap.materials_total)).toBe(3_000);
    expect(num(snap.cis_gross_payment)).toBe(10_000);
    expect(snap.cis_status).toBe("standard_20");
    expect(num(snap.deduction_rate)).toBe(20);
  });

  it("higher rate: the same bill deducts 30% of labour", async () => {
    const bill = await mkBill(orgA, sub30, 10_000, 0);
    await setDetails(orgA, sub30, bill, { materials: 3_000 });
    const r = await post(asAdmin(), orgA, sub30, [{ finance_id: bill, amount: 10_000 }]);
    expect(r.error, r.error?.message).toBeNull();
    expect(num((await paymentRow(String(r.data))).cis_withheld)).toBe(2_100);
  });

  it("gross payment status deducts nothing but still records a snapshot", async () => {
    const bill = await mkBill(orgA, subGross, 5_000, 0);
    const r = await post(asAdmin(), orgA, subGross, [{ finance_id: bill, amount: 5_000 }]);
    expect(r.error, r.error?.message).toBeNull();
    const id = String(r.data);
    expect(num((await paymentRow(id)).cis_withheld)).toBe(0);
    const snap = await snapshotRow(id);
    expect(snap.cis_status).toBe("gross");
    expect(num(snap.deduction_rate)).toBe(0);
    // Proof the check was done, not skipped.
    expect(num(snap.cis_basis)).toBe(5_000);
  });

  it("VAT is never in the basis — a 20% VAT bill deducts the same as a 0% one", async () => {
    const vatBill = await mkBill(orgA, sub20, 1_000, 20); // gross 1,200
    await setDetails(orgA, sub20, vatBill, { materials: 400 });
    const r = await post(asAdmin(), orgA, sub20, [{ finance_id: vatBill, amount: 1_200 }]);
    expect(r.error, r.error?.message).toBeNull();
    const pay = await paymentRow(String(r.data));
    expect(num(pay.gross_amount)).toBe(1_200);
    expect(num(pay.cis_withheld)).toBe(120); // 600 labour x 20% — VAT excluded
    expect(num(pay.net_paid)).toBe(1_080);
    // If VAT had leaked into the basis: (1200 - 400) x 20% = 160.
    expect(num(pay.cis_withheld)).not.toBe(160);
  });

  it("the CITB levy comes off the gross payment before materials (CISR15110)", async () => {
    // HMRC's worked example: 1,000 contract, 7 levy => 993 reported gross.
    const bill = await mkBill(orgA, sub20, 1_000, 0);
    await setDetails(orgA, sub20, bill, { citb: 7, materials: 200 });
    const r = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 1_000 }]);
    expect(r.error, r.error?.message).toBeNull();
    const snap = await snapshotRow(String(r.data));
    expect(num(snap.cis_gross_payment)).toBe(993);
    expect(num(snap.citb_total)).toBe(7);
    expect(num(snap.cis_basis)).toBe(793);
    expect(num((await paymentRow(String(r.data))).cis_withheld)).toBe(158.6);
  });

  it("labour-only and materials-only bills sit at the two extremes", async () => {
    const labour = await mkBill(orgA, sub20, 2_000, 0);
    const r1 = await post(asAdmin(), orgA, sub20, [{ finance_id: labour, amount: 2_000 }]);
    expect(r1.error, r1.error?.message).toBeNull();
    expect(num((await paymentRow(String(r1.data))).cis_withheld)).toBe(400);

    const mats = await mkBill(orgA, sub20, 2_000, 0);
    await setDetails(orgA, sub20, mats, { materials: 2_000 });
    const r2 = await post(asAdmin(), orgA, sub20, [{ finance_id: mats, amount: 2_000 }]);
    expect(r2.error, r2.error?.message).toBeNull();
    expect(num((await paymentRow(String(r2.data))).cis_withheld)).toBe(0);
  });

  it("a bill with no CIS details is treated as all labour — the safe default", async () => {
    const bill = await mkBill(orgA, sub20, 800, 0);
    const r = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 800 }]);
    expect(r.error, r.error?.message).toBeNull();
    // 160, not 0: forgetting the split over-deducts rather than under-reports.
    expect(num((await paymentRow(String(r.data))).cis_withheld)).toBe(160);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 2. PARTIAL PAYMENTS — the highest-risk area
  // ═════════════════════════════════════════════════════════════════════════

  it("10,000 paid 4,000 then 6,000 totals exactly the single-payment deduction", async () => {
    const bill = await mkBill(orgA, sub20, 10_000, 0);
    await setDetails(orgA, sub20, bill, { materials: 3_000 });

    const a = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 4_000 }], { ref: `${T}-p1` });
    expect(a.error, a.error?.message).toBeNull();
    const b = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 6_000 }], { ref: `${T}-p2` });
    expect(b.error, b.error?.message).toBeNull();

    expect(num((await paymentRow(String(a.data))).cis_withheld)).toBe(560); // 40%
    expect(num((await paymentRow(String(b.data))).cis_withheld)).toBe(840); // 60%

    const rows = await allocsFor(bill);
    expect(p2(rows.reduce((s, x) => s + num(x.cis_deduction), 0))).toBe(1_400);
    // The material allowance was applied ONCE, not per payment.
    expect(p2(rows.reduce((s, x) => s + num(x.cis_basis), 0))).toBe(7_000);
  });

  it("no rounding drift: 100 bill / 66.67 materials paid 50 twice totals 6.67, not 6.66", async () => {
    const bill = await mkBill(orgA, sub20, 100, 0);
    await setDetails(orgA, sub20, bill, { materials: 66.67 }); // labour 33.33

    const a = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 50 }], { ref: `${T}-d1` });
    expect(a.error, a.error?.message).toBeNull();
    const b = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 50 }], { ref: `${T}-d2` });
    expect(b.error, b.error?.message).toBeNull();

    const deds = (await allocsFor(bill)).map((r) => num(r.cis_deduction));
    expect(deds).toEqual([3.33, 3.34]);
    expect(p2(deds[0]! + deds[1]!)).toBe(6.67);
    // The naive per-payment method gives 6.66 — a penny lost on the return.
    expect(p2(deds[0]! + deds[1]!)).not.toBe(6.66);
  });

  it("stays exact across many awkward instalments including 1p and 2p", async () => {
    const bill = await mkBill(orgA, sub20, 100, 0);
    await setDetails(orgA, sub20, bill, { materials: 33.33, citb: 0.01 });
    // basis = 100 - 0.01 - 33.33 = 66.66 -> 20% = 13.33 (13.332 rounded)
    const amounts = [0.01, 0.02, 0.03, 9.94, 30, 30, 30];
    for (let i = 0; i < amounts.length; i++) {
      const r = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: amounts[i]! }], {
        ref: `${T}-many-${i}`,
      });
      expect(r.error, `instalment ${i}: ${r.error?.message}`).toBeNull();
    }
    const rows = await allocsFor(bill);
    expect(p2(rows.reduce((s, x) => s + num(x.amount), 0))).toBe(100);
    expect(p2(rows.reduce((s, x) => s + num(x.cis_deduction), 0))).toBe(13.33);
    expect(p2(rows.reduce((s, x) => s + num(x.cis_basis), 0))).toBe(66.66);
    for (const row of rows) expect(num(row.cis_deduction)).toBeGreaterThanOrEqual(0);
  });

  it("allocation can never exceed the bill's outstanding balance", async () => {
    const bill = await mkBill(orgA, sub20, 500, 0);
    const a = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 400 }], { ref: `${T}-o1` });
    expect(a.error, a.error?.message).toBeNull();
    const b = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 200 }], { ref: `${T}-o2` });
    expect(b.error?.message ?? "").toMatch(/over-paid/i);
    // And nothing was written.
    expect((await allocsFor(bill)).length).toBe(1);
  });

  it("one payment across MULTIPLE bills keeps each bill's own basis", async () => {
    const labour = await mkBill(orgA, sub20, 1_000, 0);
    const mixed = await mkBill(orgA, sub20, 2_000, 0);
    await setDetails(orgA, sub20, mixed, { materials: 1_500 });

    const r = await post(asAdmin(), orgA, sub20, [
      { finance_id: labour, amount: 1_000 },
      { finance_id: mixed, amount: 2_000 },
    ], { ref: `${T}-multi` });
    expect(r.error, r.error?.message).toBeNull();

    // 1,000 labour + 500 labour = 1,500 basis -> 300. An AVERAGED basis would be wrong.
    const pay = await paymentRow(String(r.data));
    expect(num(pay.gross_amount)).toBe(3_000);
    expect(num(pay.cis_withheld)).toBe(300);
    const snap = await snapshotRow(String(r.data));
    expect(num(snap.cis_basis)).toBe(1_500);
    expect(num(snap.materials_total)).toBe(1_500);
  });

  it("refuses the same bill twice on one payment", async () => {
    const bill = await mkBill(orgA, sub20, 500, 0);
    const r = await post(asAdmin(), orgA, sub20, [
      { finance_id: bill, amount: 100 },
      { finance_id: bill, amount: 100 },
    ]);
    expect(r.error?.message ?? "").toMatch(/appears twice/i);
  });

  it("a void releases its deduction and the next payment picks it up exactly", async () => {
    const bill = await mkBill(orgA, sub20, 100, 0);
    await setDetails(orgA, sub20, bill, { materials: 66.67 });

    const a = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 50 }], { ref: `${T}-v1` });
    expect(a.error, a.error?.message).toBeNull();
    expect(num((await paymentRow(String(a.data))).cis_withheld)).toBe(3.33);

    const v = await svc()
      .from("supplier_payments")
      .update({ voided_at: new Date().toISOString(), void_reason: "keyed wrong" })
      .eq("id", String(a.data));
    expect(v.error, v.error?.message).toBeNull();

    // The voided payment's figures are UNCHANGED — history does not move.
    const stillThere = await allocsFor(bill);
    expect(num(stillThere[0]!.cis_deduction)).toBe(3.33);

    // The replacement full payment now carries the WHOLE deduction.
    const b = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 100 }], { ref: `${T}-v2` });
    expect(b.error, b.error?.message).toBeNull();
    expect(num((await paymentRow(String(b.data))).cis_withheld)).toBe(6.67);
  });

  it("concurrent payments against one bill cannot both take the same deduction", async () => {
    const bill = await mkBill(orgA, sub20, 1_000, 0);
    await setDetails(orgA, sub20, bill, { materials: 400 }); // basis 600, total CIS 120

    const [r1, r2] = await Promise.all([
      post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 500 }], { ref: `${T}-c1` }),
      post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 500 }], { ref: `${T}-c2` }),
    ]);
    // Both may succeed (500 + 500 fits the bill) but the TOTAL must be exact.
    const ok = [r1, r2].filter((r) => !r.error);
    expect(ok.length).toBeGreaterThan(0);
    const rows = await allocsFor(bill);
    expect(p2(rows.reduce((s, x) => s + num(x.cis_deduction), 0))).toBeLessThanOrEqual(120);
    if (ok.length === 2) {
      expect(p2(rows.reduce((s, x) => s + num(x.cis_deduction), 0))).toBe(120);
      expect(p2(rows.reduce((s, x) => s + num(x.amount), 0))).toBe(1_000);
    }
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 3. RATE AUTHORITY — forgeries
  // ═════════════════════════════════════════════════════════════════════════

  it("REFUSES a forged rate on the service_role path (RLS bypassed)", async () => {
    const bill = await mkBill(orgA, sub20, 1_000, 0);
    await setDetails(orgA, sub20, bill, { materials: 400 });
    const pay = await svc()
      .from("supplier_payments")
      .insert({
        org_id: orgA, supplier_id: sub20, paid_at: "2026-07-02",
        gross_amount: 1_000, cis_withheld: 0, net_paid: 1_000,
      })
      .select("id")
      .single();
    expect(pay.error, pay.error?.message).toBeNull();

    // 30% claimed on a subcontractor verified at 20%.
    const forged = await svc().from("supplier_payment_allocations").insert({
      org_id: orgA, payment_id: String(pay.data?.id), supplier_id: sub20,
      finance_id: bill, amount: 1_000,
      cis_rate_applied: 30, cis_bill_net: 1_000, cis_bill_gross: 1_000,
      cis_bill_materials: 400, cis_bill_citb: 0,
      cis_basis: 600, cis_deduction: 180,
      cis_vat_treatment: "standard", cis_reverse_charge_vat: 0,
    });
    expect(forged.error?.message ?? "").toMatch(/does not match this subcontractor's verified rate/i);
  });

  it("REFUSES an inconsistent expected_rate through the RPC", async () => {
    const bill = await mkBill(orgA, sub20, 500, 0);
    for (const rate of [17, 30, 99, 0]) {
      const r = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 100 }], {
        expectedRate: rate,
      });
      expect(r.error?.message ?? "", `rate ${rate}`).toMatch(/does not match/i);
    }
    // …and the honest rate goes through.
    const ok = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 100 }], {
      expectedRate: 20,
    });
    expect(ok.error, ok.error?.message).toBeNull();
  });

  it("REFUSES a forged deduction basis (materials zeroed to inflate the deduction)", async () => {
    const bill = await mkBill(orgA, sub20, 1_000, 0);
    await setDetails(orgA, sub20, bill, { materials: 400 });
    const pay = await svc()
      .from("supplier_payments")
      .insert({
        org_id: orgA, supplier_id: sub20, paid_at: "2026-07-02",
        gross_amount: 1_000, cis_withheld: 0, net_paid: 1_000,
      })
      .select("id")
      .single();

    const forged = await svc().from("supplier_payment_allocations").insert({
      org_id: orgA, payment_id: String(pay.data?.id), supplier_id: sub20,
      finance_id: bill, amount: 1_000,
      cis_rate_applied: 20, cis_bill_net: 1_000, cis_bill_gross: 1_000,
      cis_bill_materials: 0, cis_bill_citb: 0, // <- the lie
      cis_basis: 1_000, cis_deduction: 200,
      cis_vat_treatment: "standard", cis_reverse_charge_vat: 0,
    });
    expect(forged.error?.message ?? "").toMatch(/does not match bill/i);
  });

  it("REFUSES an honest bill copy with a hand-tuned deduction", async () => {
    const bill = await mkBill(orgA, sub20, 1_000, 0);
    await setDetails(orgA, sub20, bill, { materials: 400 });
    const pay = await svc()
      .from("supplier_payments")
      .insert({
        org_id: orgA, supplier_id: sub20, paid_at: "2026-07-02",
        gross_amount: 1_000, cis_withheld: 0, net_paid: 1_000,
      })
      .select("id")
      .single();

    const forged = await svc().from("supplier_payment_allocations").insert({
      org_id: orgA, payment_id: String(pay.data?.id), supplier_id: sub20,
      finance_id: bill, amount: 1_000,
      cis_rate_applied: 20, cis_bill_net: 1_000, cis_bill_gross: 1_000,
      cis_bill_materials: 400, cis_bill_citb: 0,
      cis_basis: 600, cis_deduction: 200, // should be 120
      cis_vat_treatment: "standard", cis_reverse_charge_vat: 0,
    });
    expect(forged.error?.message ?? "").toMatch(/are wrong/i);
  });

  it("REFUSES a CIS allocation with no snapshot to explain the rate", async () => {
    const bill = await mkBill(orgA, sub20, 1_000, 0);
    const pay = await svc()
      .from("supplier_payments")
      .insert({
        org_id: orgA, supplier_id: sub20, paid_at: "2026-07-02",
        gross_amount: 1_000, cis_withheld: 200, net_paid: 800,
      })
      .select("id")
      .single();

    const r = await svc().from("supplier_payment_allocations").insert({
      org_id: orgA, payment_id: String(pay.data?.id), supplier_id: sub20,
      finance_id: bill, amount: 1_000,
      cis_rate_applied: 20, cis_bill_net: 1_000, cis_bill_gross: 1_000,
      cis_bill_materials: 0, cis_bill_citb: 0,
      cis_basis: 1_000, cis_deduction: 200,
      cis_vat_treatment: "standard", cis_reverse_charge_vat: 0,
    });
    expect(r.error?.message ?? "").toMatch(/no CIS snapshot/i);
  });

  it("REFUSES a snapshot whose totals disagree with its allocations", async () => {
    const bill = await mkBill(orgA, sub20, 1_000, 0);
    const r = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 1_000 }], {
      ref: `${T}-snapmatch`,
    });
    expect(r.error, r.error?.message).toBeNull();

    // A SECOND, lying snapshot for the same payment must be impossible: the PK
    // stops a duplicate, and the deferred totals trigger stops a wrong one.
    const dup = await svc().from("cis_payment_snapshots").insert({
      org_id: orgA, payment_id: String(r.data), supplier_id: sub20,
      cis_status: "standard_20", deduction_rate: 20, legal_name: "x",
      cis_gross_payment: 1_000, materials_total: 0, citb_total: 0,
      cis_basis: 1_000, cis_deduction: 999,
      tax_month_start: "2026-06-06", tax_month_end: "2026-07-05",
    });
    expect(dup.error).not.toBeNull();
  });

  it("REFUSES a payment to an unverified subcontractor — no silent 20% or 30%", async () => {
    const bill = await mkBill(orgA, subUnver, 500, 0);
    const r = await post(asAdmin(), orgA, subUnver, [{ finance_id: bill, amount: 500 }]);
    expect(r.error?.message ?? "").toMatch(/not verified for CIS/i);
  });

  it("REFUSES a CIS payment to a supplier with no CIS record at all", async () => {
    const bill = await mkBill(orgA, merch, 400, 0);
    const r = await post(asAdmin(), orgA, merch, [{ finance_id: bill, amount: 400 }]);
    expect(r.error?.message ?? "").toMatch(/not set up as a CIS subcontractor/i);
    // …but M2's ordinary payment path still works for them, with 0 withheld.
    const m2 = await asAdmin().rpc("record_supplier_payment", {
      p_org_id: orgA, p_supplier_id: merch, p_paid_at: "2026-07-01",
      p_method: "bank_transfer", p_reference: `${T}-merch`,
      p_gross_amount: 400, p_cis_withheld: 0, p_notes: null,
      p_allocations: [{ finance_id: bill, amount: 400 }],
    });
    expect(m2.error, m2.error?.message).toBeNull();
  });

  it("REFUSES a payment with no bills — there is no basis without one", async () => {
    const r = await post(asAdmin(), orgA, sub20, []);
    expect(r.error?.message ?? "").toMatch(/at least one bill/i);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 3b. STALE VERIFICATION (20261175000000)
  //   A verification is valid THROUGH its expiry date; a payment dated strictly
  //   after it must be refused — the old rate has no authority and posting it
  //   would under-deduct if HMRC has moved the subcontractor to the higher rate.
  // ═════════════════════════════════════════════════════════════════════════

  it("REFUSES a payment dated after the subcontractor's verification expired", async () => {
    const sub = await mkSupplier(orgA, "Lapsed");
    // Verified in 2020, explicit expiry 2022-04-05 — long stale.
    const ins = await svc().from("cis_subcontractors").insert({
      org_id: orgA, supplier_id: sub, legal_name: "Lapsed Ltd", utr: "1234567890",
      cis_status: "standard_20", verified_at: "2020-01-01",
      verification_expires_at: "2022-04-05", verification_reference: "V1234567890",
    });
    expect(ins.error, ins.error?.message).toBeNull();
    const bill = await mkBill(orgA, sub, 1_000, 0);

    const r = await post(asAdmin(), orgA, sub, [{ finance_id: bill, amount: 1_000 }], {
      paidAt: "2026-07-01",
    });
    expect(r.error?.message ?? "").toMatch(/verification for supplier .* expired/i);
    // Nothing was written — no payment, no allocation, no snapshot.
    const pays = await svc().from("supplier_payments").select("id").eq("supplier_id", sub);
    expect((pays.data ?? []).length).toBe(0);
  });

  it("REFUSES when the expiry is only DERIVED (column left null) and the date is past", async () => {
    const sub = await mkSupplier(orgA, "DerivedStale");
    // verified 2020-06-01 → tax year 2020/21 → derived expiry 2023-04-05.
    const ins = await svc().from("cis_subcontractors").insert({
      org_id: orgA, supplier_id: sub, legal_name: "DerivedStale Ltd", utr: "1234567890",
      cis_status: "higher_30", verified_at: "2020-06-01", verification_reference: "V1234567890",
    });
    expect(ins.error, ins.error?.message).toBeNull();
    const bill = await mkBill(orgA, sub, 1_000, 0);
    const r = await post(asAdmin(), orgA, sub, [{ finance_id: bill, amount: 1_000 }], {
      paidAt: "2026-07-01",
    });
    expect(r.error?.message ?? "").toMatch(/verification for supplier .* expired/i);
  });

  it("POSTS a payment dated ON the expiry date (valid THROUGH it)", async () => {
    const sub = await mkSupplier(orgA, "OnBoundary");
    const ins = await svc().from("cis_subcontractors").insert({
      org_id: orgA, supplier_id: sub, legal_name: "OnBoundary Ltd", utr: "1234567890",
      cis_status: "standard_20", verified_at: "2023-06-01",
      verification_expires_at: "2026-04-05", verification_reference: "V1234567890",
    });
    expect(ins.error, ins.error?.message).toBeNull();
    const bill = await mkBill(orgA, sub, 1_000, 0);

    // On the expiry date: still valid.
    const ok = await post(asAdmin(), orgA, sub, [{ finance_id: bill, amount: 1_000 }], {
      paidAt: "2026-04-05", ref: `${T}-onboundary`,
    });
    expect(ok.error, ok.error?.message).toBeNull();
    expect(num((await paymentRow(String(ok.data))).cis_withheld)).toBe(200);
  });

  it("re-verifying with a fresh expiry unblocks a lapsed subcontractor", async () => {
    const sub = await mkSupplier(orgA, "Renewed");
    const ins = await svc().from("cis_subcontractors").insert({
      org_id: orgA, supplier_id: sub, legal_name: "Renewed Ltd", utr: "1234567890",
      cis_status: "standard_20", verified_at: "2020-01-01",
      verification_expires_at: "2022-04-05", verification_reference: "V1234567890",
    });
    expect(ins.error, ins.error?.message).toBeNull();
    const bill = await mkBill(orgA, sub, 1_000, 0);

    const stale = await post(asAdmin(), orgA, sub, [{ finance_id: bill, amount: 1_000 }], {
      paidAt: "2026-07-01",
    });
    expect(stale.error?.message ?? "").toMatch(/expired/i);

    // Re-record a fresh verification.
    const up = await svc().from("cis_subcontractors")
      .update({ verified_at: "2026-06-01", verification_expires_at: "2029-04-05" })
      .eq("org_id", orgA).eq("supplier_id", sub);
    expect(up.error, up.error?.message).toBeNull();

    const ok = await post(asAdmin(), orgA, sub, [{ finance_id: bill, amount: 1_000 }], {
      paidAt: "2026-07-01", ref: `${T}-renewed`,
    });
    expect(ok.error, ok.error?.message).toBeNull();
    expect(num((await paymentRow(String(ok.data))).cis_withheld)).toBe(200);
  });

  it("the trigger backstops a direct forged allocation against a stale verification", async () => {
    // Bypass the RPC entirely, as a service_role/PostgREST writer would.
    const sub = await mkSupplier(orgA, "DirectStale");
    const ins = await svc().from("cis_subcontractors").insert({
      org_id: orgA, supplier_id: sub, legal_name: "DirectStale Ltd", utr: "1234567890",
      cis_status: "standard_20", verified_at: "2020-01-01",
      verification_expires_at: "2022-04-05", verification_reference: "V1234567890",
    });
    expect(ins.error, ins.error?.message).toBeNull();
    const bill = await mkBill(orgA, sub, 1_000, 0);
    const pay = await svc().from("supplier_payments").insert({
      org_id: orgA, supplier_id: sub, paid_at: "2026-07-02",
      gross_amount: 1_000, cis_withheld: 200, net_paid: 800,
    }).select("id").single();
    expect(pay.error, pay.error?.message).toBeNull();

    const forged = await svc().from("supplier_payment_allocations").insert({
      org_id: orgA, payment_id: String(pay.data?.id), supplier_id: sub,
      finance_id: bill, amount: 1_000,
      cis_rate_applied: 20, cis_bill_net: 1_000, cis_bill_gross: 1_000,
      cis_bill_materials: 0, cis_bill_citb: 0,
      cis_basis: 1_000, cis_deduction: 200,
      cis_vat_treatment: "standard", cis_reverse_charge_vat: 0,
    });
    expect(forged.error?.message ?? "").toMatch(/verification for supplier .* expired/i);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 4. IMMUTABILITY
  // ═════════════════════════════════════════════════════════════════════════

  it("re-verifying at a DIFFERENT rate does not move a posted payment", async () => {
    const flip = await mkSupplier(orgA, "Flipper");
    await mkCis(orgA, flip, "standard_20", "Flipper");
    const bill = await mkBill(orgA, flip, 1_000, 0);

    const r = await post(asAdmin(), orgA, flip, [{ finance_id: bill, amount: 1_000 }], {
      ref: `${T}-flip`,
    });
    expect(r.error, r.error?.message).toBeNull();
    const before = await snapshotRow(String(r.data));
    expect(num(before.cis_deduction)).toBe(200);

    // Re-verify at the higher rate, and change the UTR and the legal name too.
    const up = await svc()
      .from("cis_subcontractors")
      .update({ cis_status: "higher_30", utr: "9999999999", legal_name: "Renamed Ltd" })
      .eq("org_id", orgA)
      .eq("supplier_id", flip);
    expect(up.error, up.error?.message).toBeNull();

    const after = await snapshotRow(String(r.data));
    expect(after).toEqual(before); // byte-for-byte: nothing moved
    expect(num((await paymentRow(String(r.data))).cis_withheld)).toBe(200);

    // A NEW payment correctly uses the new rate.
    const bill2 = await mkBill(orgA, flip, 1_000, 0);
    const r2 = await post(asAdmin(), orgA, flip, [{ finance_id: bill2, amount: 1_000 }], {
      ref: `${T}-flip2`,
    });
    expect(r2.error, r2.error?.message).toBeNull();
    expect(num((await paymentRow(String(r2.data))).cis_withheld)).toBe(300);
  });

  it("the snapshot cannot be updated by anyone, including service_role", async () => {
    const bill = await mkBill(orgA, sub20, 100, 0);
    const r = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 100 }], {
      ref: `${T}-frozen`,
    });
    expect(r.error, r.error?.message).toBeNull();

    for (const client of [svc(), asAdmin()]) {
      const u = await client
        .from("cis_payment_snapshots")
        .update({ cis_deduction: 0 })
        .eq("payment_id", String(r.data));
      expect(u.error?.message ?? "").toMatch(/immutable/i);
    }
  });

  it("the snapshot cannot be deleted by anyone", async () => {
    const bill = await mkBill(orgA, sub20, 100, 0);
    const r = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 100 }], {
      ref: `${T}-nodel`,
    });
    expect(r.error, r.error?.message).toBeNull();
    const d = await svc()
      .from("cis_payment_snapshots")
      .delete()
      .eq("payment_id", String(r.data));
    expect(d.error?.message ?? "").toMatch(/cannot be deleted/i);
  });

  it("the allocation's frozen CIS columns cannot be edited", async () => {
    const bill = await mkBill(orgA, sub20, 100, 0);
    const r = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 100 }], {
      ref: `${T}-allocfrozen`,
    });
    expect(r.error, r.error?.message).toBeNull();
    const u = await svc()
      .from("supplier_payment_allocations")
      .update({ cis_deduction: 0, cis_rate_applied: 0 })
      .eq("finance_id", bill);
    expect(u.error?.message ?? "").toMatch(/immutable/i);
  });

  it("a bill's labour/materials split freezes once it has been part-paid", async () => {
    const bill = await mkBill(orgA, sub20, 1_000, 0);
    await setDetails(orgA, sub20, bill, { materials: 400 });
    // Editable while unpaid.
    expect((await setDetails(orgA, sub20, bill, { materials: 500 })).error).toBeNull();

    const r = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 500 }], {
      ref: `${T}-freeze`,
    });
    expect(r.error, r.error?.message).toBeNull();

    // Frozen now — including for service_role.
    const after = await setDetails(orgA, sub20, bill, { materials: 100 });
    expect(after.error?.message ?? "").toMatch(/part-paid under CIS/i);

    // And the details row cannot be deleted to dodge the freeze.
    const d = await svc().from("cis_bill_details").delete().eq("finance_id", bill);
    expect(d.error?.message ?? "").toMatch(/cannot be deleted/i);
  });

  it("a part-paid bill's VALUE is refused at source, not at the next payment", async () => {
    // THIS TEST CHANGED IN 20261053000000, and the change is the point.
    //
    // M3 as first shipped left `finances.amount` and `vat_rate` mutable, on the
    // grounds that `finances` is the general cost ledger and a tax migration
    // should not police writes to it. So the edit SUCCEEDED and the divergence
    // was detected one step later, at the NEXT posting, by the "has changed
    // since it was part-paid" check. Conservative and never wrong — it cannot
    // mis-apportion — but it reported the problem against a different bill line,
    // possibly to a different person, long after the context was gone, and the
    // only exit was to void every earlier CIS payment on the bill.
    //
    // The freeze now refuses the EDIT, at the moment of the mistake, naming the
    // recovery path. The numerator of the §9 apportionment was already frozen;
    // this is its denominator.
    const bill = await mkBill(orgA, sub20, 1_000, 0);
    const a = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 500 }], {
      ref: `${T}-drift1`,
    });
    expect(a.error, a.error?.message).toBeNull();

    // Refused for service_role too — this is a trigger, not an app-layer check.
    const up = await svc().from("finances").update({ amount: 2_000 }).eq("id", bill);
    expect(up.error?.message ?? "").toMatch(/part-paid under CIS/i);
    expect(up.error?.message ?? "").toMatch(/void the CIS payments/i);

    // Frozen in BOTH directions, and the VAT rate with it: anything that moves
    // the basis moves the deduction that was reported from it.
    expect(
      (await svc().from("finances").update({ amount: 900 }).eq("id", bill)).error?.message ?? "",
    ).toMatch(/part-paid under CIS/i);
    expect(
      (await svc().from("finances").update({ vat_rate: 20 }).eq("id", bill)).error?.message ?? "",
    ).toMatch(/part-paid under CIS/i);

    // The bill is untouched, and everything that cannot move a deduction still is.
    const row = await svc().from("finances").select("amount, vat_rate").eq("id", bill).maybeSingle();
    expect(num(row.data?.amount)).toBe(1_000);
    expect(
      (await svc().from("finances").update({ notes: "re-tagged" }).eq("id", bill)).error,
    ).toBeNull();

    // And the documented way out actually works: void, correct, re-post. The
    // "has changed since it was part-paid" check in
    // tg_supplier_payment_allocation_cis is deliberately KEPT as defence in
    // depth, but with this freeze in place there is no longer a write path that
    // can reach it — which is the point of it, not a gap in this test.
    await svc()
      .from("supplier_payments")
      .update({ voided_at: new Date().toISOString(), void_reason: "bill was wrong" })
      .eq("id", String(a.data));
    expect(
      (await svc().from("finances").update({ amount: 2_000 }).eq("id", bill)).error,
      "voiding releases the bill",
    ).toBeNull();
    const b = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 500 }], {
      ref: `${T}-drift2`,
    });
    expect(b.error, b.error?.message).toBeNull();
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 5. REVERSE CHARGE
  // ═════════════════════════════════════════════════════════════════════════

  it("reverse charge preserves net value, VAT rate and the notional VAT amount", async () => {
    const bill = await mkBill(orgA, sub20, 5_000, 0); // no VAT charged
    expect((await setDetails(orgA, sub20, bill, {
      materials: 1_000, treatment: "reverse_charge", rcRate: 20,
    })).error).toBeNull();

    const r = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 5_000 }], {
      ref: `${T}-rc`,
    });
    expect(r.error, r.error?.message).toBeNull();

    const alloc = (await allocsFor(bill))[0]!;
    // Net preserved, deduction on labour only, VAT recorded as a real amount.
    expect(num(alloc.amount)).toBe(5_000);
    expect(num(alloc.cis_basis)).toBe(4_000);
    expect(num(alloc.cis_deduction)).toBe(800);
    expect(num(alloc.cis_reverse_charge_vat)).toBe(1_000); // 20% of the FULL 5,000
    expect(num((await paymentRow(String(r.data))).net_paid)).toBe(4_200);
  });

  it("a reverse-charge bill that also charges VAT is REFUSED", async () => {
    const bill = await mkBill(orgA, sub20, 1_000, 20); // charges VAT
    const r = await setDetails(orgA, sub20, bill, { treatment: "reverse_charge", rcRate: 20 });
    expect(r.error?.message ?? "").toMatch(/charges no VAT/i);
  });

  it("reverse charge without a rate, and a rate without reverse charge, are both refused", async () => {
    const bill = await mkBill(orgA, sub20, 1_000, 0);
    expect(
      (await setDetails(orgA, sub20, bill, { treatment: "reverse_charge", rcRate: null })).error,
    ).not.toBeNull();
    expect(
      (await setDetails(orgA, sub20, bill, { treatment: "standard", rcRate: 20 })).error,
    ).not.toBeNull();
  });

  it("reverse charge does NOT change the CIS deduction", async () => {
    const normal = await mkBill(orgA, sub20, 2_000, 0);
    await setDetails(orgA, sub20, normal, { materials: 500 });
    const rc = await mkBill(orgA, sub20, 2_000, 0);
    await setDetails(orgA, sub20, rc, {
      materials: 500, treatment: "reverse_charge", rcRate: 20,
    });

    const a = await post(asAdmin(), orgA, sub20, [{ finance_id: normal, amount: 2_000 }], { ref: `${T}-n` });
    const b = await post(asAdmin(), orgA, sub20, [{ finance_id: rc, amount: 2_000 }], { ref: `${T}-r` });
    expect(a.error, a.error?.message).toBeNull();
    expect(b.error, b.error?.message).toBeNull();
    expect(num((await paymentRow(String(a.data))).cis_withheld)).toBe(
      num((await paymentRow(String(b.data))).cis_withheld),
    );
  });

  it("EXISTING VAT REPORTING IS UNCHANGED — computeVatQuarter is byte-identical", async () => {
    // Read the org's finances exactly as app/api/tax/quarterly-pdf does, run the
    // real reporter, then post reverse-charge and standard CIS payments and run
    // it again. `computeVatQuarter` sums finances.vat_total and M3 never writes
    // finances, so the two results must match EXACTLY.
    const readFinances = async () => {
      const r = await svc()
        .from("finances")
        .select("category, amount, vat_total, created_at")
        .eq("org_id", orgA);
      return (r.data ?? []) as unknown as Array<{
        amount: number | string | null;
        vat_total: number | string | null;
        created_at: string;
      }>;
    };

    const quarterStart = "2020-01-01";
    const before = computeVatQuarter([], await readFinances(), quarterStart);

    const rcBill = await mkBill(orgA, sub20, 3_000, 0);
    await setDetails(orgA, sub20, rcBill, { treatment: "reverse_charge", rcRate: 20 });
    const stdBill = await mkBill(orgA, sub20, 1_000, 20);
    await setDetails(orgA, sub20, stdBill, { materials: 200 });

    // Adding the BILLS changes input VAT (that is the pre-existing behaviour and
    // is correct — a standard-rated bill really does carry recoverable VAT).
    const withBills = computeVatQuarter([], await readFinances(), quarterStart);
    expect(withBills.input_vat).toBe(Math.round((before.input_vat + 200) * 100) / 100);
    // The reverse-charge bill contributed ZERO input VAT — the correct net effect,
    // since the customer raises output tax and recovers the same as input tax.

    const r1 = await post(asAdmin(), orgA, sub20, [{ finance_id: rcBill, amount: 3_000 }], { ref: `${T}-vr1` });
    const r2 = await post(asAdmin(), orgA, sub20, [{ finance_id: stdBill, amount: 1_200 }], { ref: `${T}-vr2` });
    expect(r1.error, r1.error?.message).toBeNull();
    expect(r2.error, r2.error?.message).toBeNull();

    // RECORDING THE PAYMENTS moved the VAT report by NOTHING.
    const after = computeVatQuarter([], await readFinances(), quarterStart);
    expect(after).toEqual(withBills);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 6. TENANT ISOLATION
  // ═════════════════════════════════════════════════════════════════════════

  it("a same-org MEMBER sees no CIS details and no snapshots, and can write neither", async () => {
    const bill = await mkBill(orgA, sub20, 100, 0);
    await setDetails(orgA, sub20, bill, { materials: 10 });
    const r = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 100 }], {
      ref: `${T}-memb`,
    });
    expect(r.error, r.error?.message).toBeNull();

    const details = await asMember().from("cis_bill_details").select("finance_id").eq("org_id", orgA);
    expect(details.data ?? []).toEqual([]);
    const snaps = await asMember().from("cis_payment_snapshots").select("payment_id").eq("org_id", orgA);
    expect(snaps.data ?? []).toEqual([]);

    const write = await asMember().from("cis_bill_details").upsert({
      org_id: orgA, finance_id: bill, supplier_id: sub20, materials_amount: 0,
    });
    expect(write.error).not.toBeNull();

    const rpc = await post(asMember(), orgA, sub20, [{ finance_id: bill, amount: 1 }]);
    expect(rpc.error?.message ?? "").toMatch(/only an owner or admin|row-level security/i);

    // But `finances` — the COST — stays member-readable. CIS hides tax, not cost.
    const cost = await asMember().from("finances").select("id, amount").eq("id", bill);
    expect((cost.data ?? []).length).toBe(1);
  });

  it("CROSS-ORG: another org's admin cannot read or write orgA's CIS data", async () => {
    const bill = await mkBill(orgA, sub20, 100, 0);
    await setDetails(orgA, sub20, bill, { materials: 10 });

    const read = await asAdminB().from("cis_bill_details").select("finance_id").eq("org_id", orgA);
    expect(read.data ?? []).toEqual([]);

    const rpc = await post(asAdminB(), orgA, sub20, [{ finance_id: bill, amount: 10 }]);
    expect(rpc.error?.message ?? "").toMatch(/only an owner or admin/i);

    // And the composite FK stops a forged cross-tenant row even for service_role.
    const forged = await svc().from("cis_bill_details").insert({
      org_id: orgB, finance_id: bill, supplier_id: sub20, materials_amount: 0,
    });
    expect(forged.error).not.toBeNull();
  });

  it("CROSS-SUPPLIER: a bill cannot carry another supplier's CIS details", async () => {
    const bill = await mkBill(orgA, sub20, 100, 0);
    const forged = await svc().from("cis_bill_details").insert({
      org_id: orgA, finance_id: bill, supplier_id: sub30, materials_amount: 0,
    });
    expect(forged.error).not.toBeNull();
  });

  it("a supplier-less finances row can never carry CIS details", async () => {
    const plain = await mkBill(orgA, null, 500, 0);
    const r = await svc().from("cis_bill_details").insert({
      org_id: orgA, finance_id: plain, supplier_id: sub20, materials_amount: 0,
    });
    expect(r.error).not.toBeNull();
  });

  it("the RPC refuses a bill belonging to a different supplier", async () => {
    const other = await mkBill(orgA, sub30, 500, 0);
    const r = await post(asAdmin(), orgA, sub20, [{ finance_id: other, amount: 100 }]);
    expect(r.error?.message ?? "").toMatch(/not an open bill for this supplier/i);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 7. TAX MONTHS
  // ═════════════════════════════════════════════════════════════════════════

  it("freezes the CIS tax month (6th to 5th), matching lib/cis/tax-month", async () => {
    for (const [paidAt, start, end] of [
      ["2026-06-05", "2026-05-06", "2026-06-05"],
      ["2026-06-06", "2026-06-06", "2026-07-05"],
      ["2026-01-03", "2025-12-06", "2026-01-05"],
    ] as const) {
      const bill = await mkBill(orgA, sub20, 100, 0);
      const r = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 100 }], {
        paidAt, ref: `${T}-tm-${paidAt}`,
      });
      expect(r.error, r.error?.message).toBeNull();
      const snap = await snapshotRow(String(r.data));
      expect(String(snap.tax_month_start)).toBe(start);
      expect(String(snap.tax_month_end)).toBe(end);
      // The SQL and TS twins must never disagree.
      expect(cisTaxMonth(paidAt)).toEqual({ start, end });
    }
  });

  it("masks the UTR in the snapshot rather than copying it", async () => {
    const bill = await mkBill(orgA, sub20, 100, 0);
    const r = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 100 }], {
      ref: `${T}-utr`,
    });
    expect(r.error, r.error?.message).toBeNull();
    const snap = await snapshotRow(String(r.data));
    expect(String(snap.utr_masked)).toMatch(/^[^0-9]+7890$/);
    expect(String(snap.utr_masked)).not.toContain("123456");
  });

  // ═════════════════════════════════════════════════════════════════════════
  // 8. THE LOAD-BEARING INVARIANT — cost does not move
  // ═════════════════════════════════════════════════════════════════════════

  it("recording CIS payments does not move job cost or profitability by a penny", async () => {
    const job = String(
      (await svc().from("jobs").insert({ org_id: orgA, notes: `${T} Invariant` }).select("id").single())
        .data?.id,
    );
    const bill = await mkBill(orgA, sub20, 10_000, 0, job);
    await setDetails(orgA, sub20, bill, { materials: 3_000 });

    const readCosts = async () => {
      const r = await svc()
        .from("finances")
        .select("amount, vat_total, job_id, category")
        .eq("job_id", job);
      return (r.data ?? []) as unknown as Parameters<typeof computeJobProfitability>[2];
    };

    const before = computeJobProfitability(job, [], await readCosts());
    const beforeRows = await readCosts();

    const r = await post(asAdmin(), orgA, sub20, [{ finance_id: bill, amount: 10_000 }], {
      ref: `${T}-invariant`,
    });
    expect(r.error, r.error?.message).toBeNull();
    expect(num((await paymentRow(String(r.data))).cis_withheld)).toBe(1_400);

    const after = computeJobProfitability(job, [], await readCosts());
    expect(after).toEqual(before);
    expect(after?.costs_total).toBe(10_000); // NOT 8,600
    expect(await readCosts()).toEqual(beforeRows);

    // The bill row itself is untouched: still 10,000 of cost.
    const billRow = await svc().from("finances").select("amount, vat_rate, vat_total").eq("id", bill).maybeSingle();
    expect(num(billRow.data?.amount)).toBe(10_000);
  });
});
