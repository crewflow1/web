import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import { computeJobProfitability } from "@/lib/profitability/compute";
import { computeSupplierPosition } from "@/lib/suppliers/payments";

/**
 * H2-CIS M2 — the supplier money-OUT ledger, against REAL Postgres
 * (20261047000000).
 *
 * This is a cash-and-tax ledger, so the properties under test are the ones that
 * make it trustworthy rather than merely functional:
 *
 *   1. AUTHORITY   — admin-only RLS. A same-org member gets nothing, not a
 *                    redacted row. Deliberately stricter than money-in
 *                    `payments`, which is member-writable.
 *   2. BINDING     — org, supplier and bill are bound by composite FKs, so they
 *                    hold for service_role too, not just for RLS'd callers.
 *   3. CAPS        — Σ allocations ≤ payment, Σ allocations ≤ bill gross, and
 *                    the FOR UPDATE lock that makes both race-free.
 *   4. IMMUTABILITY— write-once + void. No edit, no delete, one-way void.
 *   5. THE INVARIANT — recording a CIS payment does not move job cost by a
 *                    penny. This is the one that would silently corrupt every
 *                    profit figure in the product if it broke.
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
}
type Rpc = (fn: string, args: Record<string, unknown>) => PromiseLike<Res<unknown>>;
const db = (c: unknown) => c as unknown as { from(t: string): Table; rpc: Rpc };

const T = `it-suppay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const num = (v: unknown): number => Number(v ?? 0);

describeIntegration("H2-CIS M2 supplier payments (real Postgres)", () => {
  let orgA = "";
  let orgB = "";
  let subA = ""; // org A, HAS a CIS profile
  let merchA = ""; // org A, no CIS profile
  let subB = ""; // org B
  let jobA = "";
  let billA = ""; // orgA / subA / 10000 net + 0 VAT  = 10000 gross, on jobA
  let billVat = ""; // orgA / subA / 1000 net + 200 VAT = 1200 gross
  let billMerch = ""; // orgA / merchA / 400 gross
  let billNoSupplier = ""; // orgA / no supplier
  let billB = ""; // orgB / subB
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

  /** A payment written straight through service_role (bypasses the RPC). */
  async function mkPayment(
    org: string,
    supplier: string,
    gross: number,
    withheld = 0,
  ): Promise<string> {
    const r = await svc()
      .from("supplier_payments")
      .insert({
        org_id: org,
        supplier_id: supplier,
        paid_at: "2026-07-01",
        gross_amount: gross,
        cis_withheld: withheld,
        net_paid: Math.round((gross - withheld) * 100) / 100,
      })
      .select("id")
      .single();
    expect(r.error, r.error?.message).toBeNull();
    return String(r.data?.id ?? "");
  }

  beforeAll(async () => {
    orgA = String(
      (await svc().from("organizations").insert({ name: "Pay A", slug: `${T}-a` }).select("id").single())
        .data?.id,
    );
    orgB = String(
      (await svc().from("organizations").insert({ name: "Pay B", slug: `${T}-b` }).select("id").single())
        .data?.id,
    );

    subA = String(
      (await svc().from("suppliers").insert({ org_id: orgA, name: `${T} Groundworks` }).select("id").single())
        .data?.id,
    );
    merchA = String(
      (await svc().from("suppliers").insert({ org_id: orgA, name: `${T} Merchant` }).select("id").single())
        .data?.id,
    );
    subB = String(
      (await svc().from("suppliers").insert({ org_id: orgB, name: `${T} Roofing` }).select("id").single())
        .data?.id,
    );

    // subA is a verified 20% CIS subcontractor; merchA deliberately is not.
    const cis = await svc().from("cis_subcontractors").insert({
      org_id: orgA,
      supplier_id: subA,
      legal_name: "Groundworks Ltd",
      cis_status: "standard_20",
      deduction_rate: 20,
      verified_at: "2026-06-01",
    });
    expect(cis.error, cis.error?.message).toBeNull();

    jobA = String(
      (await svc().from("jobs").insert({ org_id: orgA, notes: `${T} Job` }).select("id").single()).data
        ?.id,
    );

    billA = await mkBill(orgA, subA, 10_000, 0, jobA);
    billVat = await mkBill(orgA, subA, 1_000, 20);
    billMerch = await mkBill(orgA, merchA, 400, 0);
    billNoSupplier = await mkBill(orgA, null, 500, 0);
    billB = await mkBill(orgB, subB, 300, 0);

    admin = await mkMember(orgA, "admin", "adm");
    member = await mkMember(orgA, "staff", "mem");
    adminB = await mkMember(orgB, "admin", "admb");
  });

  afterAll(async () => {
    // NOTE: `delete from organizations` currently FAILS for any org holding a
    // `finances` row — a pre-existing defect in `_tg_finances_activity`, which
    // logs to `activity_log` after the org row is gone. Unrelated to this
    // milestone (reproducible with a bare org + one finances row). Fixtures are
    // TOKEN-tagged precisely so leftover rows cannot affect a later run.
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (orgB) await svc().from("organizations").delete().eq("id", orgB);
    for (const m of [admin, member, adminB]) {
      if (m.id) await serviceClient().auth.admin.deleteUser(m.id);
    }
  });

  // =========================================================================
  // 1. AUTHORITY — admin-only RLS
  // =========================================================================

  it("an org ADMIN can record a payment with allocations via the RPC (positive control)", async () => {
    const res = await asAdmin().rpc("record_supplier_payment", {
      p_org_id: orgA,
      p_supplier_id: subA,
      p_paid_at: "2026-07-01",
      p_method: "bank_transfer",
      p_reference: `${T}-P1`,
      p_gross_amount: 10_000,
      p_cis_withheld: 2_000,
      p_notes: null,
      p_allocations: [{ finance_id: billA, amount: 10_000 }],
    });
    expect(res.error, res.error?.message).toBeNull();
    const id = String(res.data ?? "");
    expect(id).toMatch(/[0-9a-f-]{36}/);

    const row = await svc().from("supplier_payments").select("*").eq("id", id).maybeSingle();
    expect(num(row.data?.gross_amount)).toBe(10_000);
    expect(num(row.data?.cis_withheld)).toBe(2_000);
    expect(num(row.data?.net_paid), "net is derived, never keyed").toBe(8_000);
    expect(row.data?.created_by, "the RPC stamps the caller").toBe(admin.id);

    const allocs = await svc()
      .from("supplier_payment_allocations")
      .select("amount, finance_id, supplier_id")
      .eq("payment_id", id);
    expect((allocs.data ?? []).length).toBe(1);
    expect(allocs.data?.[0]?.supplier_id, "the allocation carries the payment's supplier").toBe(subA);
  });

  it("a NON-ADMIN member of the SAME org cannot READ the ledger", async () => {
    const pay = await asMember().from("supplier_payments").select("id, gross_amount").eq("org_id", orgA);
    expect(pay.error).toBeNull();
    expect((pay.data ?? []).length, "staff must see zero payments").toBe(0);

    const alloc = await asMember().from("supplier_payment_allocations").select("id").eq("org_id", orgA);
    expect((alloc.data ?? []).length, "staff must see zero allocations").toBe(0);
  });

  it("a NON-ADMIN member cannot record a payment — through the RPC or directly", async () => {
    const rpc = await asMember().rpc("record_supplier_payment", {
      p_org_id: orgA,
      p_supplier_id: subA,
      p_paid_at: "2026-07-01",
      p_method: "cash",
      p_reference: null,
      p_gross_amount: 100,
      p_cis_withheld: 0,
      p_notes: null,
      p_allocations: [],
    });
    expect(rpc.error, "staff must be refused by the RPC's admin gate").not.toBeNull();
    expect(rpc.error?.message ?? "").toMatch(/owner or admin|insufficient/i);

    const direct = await asMember().from("supplier_payments").insert({
      org_id: orgA,
      supplier_id: subA,
      paid_at: "2026-07-01",
      gross_amount: 100,
      cis_withheld: 0,
      net_paid: 100,
    });
    expect(direct.error, "staff must be RLS-denied a direct write").not.toBeNull();
  });

  it("an ADMIN of ANOTHER org sees nothing and cannot write here", async () => {
    const sel = await asAdminB().from("supplier_payments").select("id").eq("org_id", orgA);
    expect((sel.data ?? []).length).toBe(0);

    const all = await asAdminB().from("supplier_payments").select("id, org_id");
    expect(
      (all.data ?? []).some((r) => r.org_id === orgA),
      "an unfiltered read must not leak another tenant",
    ).toBe(false);

    const rpc = await asAdminB().rpc("record_supplier_payment", {
      p_org_id: orgA,
      p_supplier_id: subA,
      p_paid_at: "2026-07-01",
      p_method: "cash",
      p_reference: null,
      p_gross_amount: 50,
      p_cis_withheld: 0,
      p_notes: null,
      p_allocations: [],
    });
    expect(rpc.error, "cross-tenant RPC must be refused").not.toBeNull();
  });

  it("an ANONYMOUS caller sees nothing and cannot insert", async () => {
    const sel = await db(anonClient()).from("supplier_payments").select("id");
    expect((sel.data ?? []).length).toBe(0);

    const ins = await db(anonClient()).from("supplier_payments").insert({
      org_id: orgA,
      supplier_id: subA,
      paid_at: "2026-07-01",
      gross_amount: 1,
      cis_withheld: 0,
      net_paid: 1,
    });
    expect(ins.error, "anon must be RLS-denied").not.toBeNull();
  });

  // =========================================================================
  // 2. BINDING — org / supplier / bill, enforced for EVERY role
  // =========================================================================

  it("a payment cannot bind to a supplier in ANOTHER org — even as service_role", async () => {
    const ins = await svc().from("supplier_payments").insert({
      org_id: orgA,
      supplier_id: subB, // org B
      paid_at: "2026-07-01",
      gross_amount: 10,
      cis_withheld: 0,
      net_paid: 10,
    });
    expect(ins.error?.message ?? "").toMatch(/foreign key|supplier_fk|violates/i);
  });

  it("an allocation cannot name a bill belonging to a DIFFERENT SUPPLIER", async () => {
    const payment = await mkPayment(orgA, subA, 1_000);
    const ins = await svc().from("supplier_payment_allocations").insert({
      org_id: orgA,
      payment_id: payment,
      supplier_id: subA,
      finance_id: billMerch, // merchA's bill
      amount: 100,
    });
    expect(ins.error?.message ?? "").toMatch(/foreign key|bill_fk|violates/i);
  });

  it("an allocation cannot claim a supplier other than its payment's", async () => {
    const payment = await mkPayment(orgA, subA, 1_000);
    const ins = await svc().from("supplier_payment_allocations").insert({
      org_id: orgA,
      payment_id: payment,
      supplier_id: merchA, // not this payment's supplier
      finance_id: billMerch,
      amount: 100,
    });
    expect(ins.error?.message ?? "").toMatch(/foreign key|payment_fk|violates/i);
  });

  it("an allocation cannot name a bill in ANOTHER ORG", async () => {
    const payment = await mkPayment(orgA, subA, 1_000);
    const ins = await svc().from("supplier_payment_allocations").insert({
      org_id: orgA,
      payment_id: payment,
      supplier_id: subA,
      finance_id: billB, // org B
      amount: 100,
    });
    expect(ins.error?.message ?? "").toMatch(/foreign key|bill_fk|violates/i);
  });

  it("a FORGED org_id on the allocation is refused by the composite FK", async () => {
    // A FRESH bill, so the caps cannot be what refuses this — the FK must be.
    const bill = await mkBill(orgA, subA, 1_000, 0);
    const payment = await mkPayment(orgA, subA, 1_000);
    const ins = await svc().from("supplier_payment_allocations").insert({
      org_id: orgB, // lie
      payment_id: payment,
      supplier_id: subA,
      finance_id: bill,
      amount: 100,
    });
    expect(ins.error?.message ?? "").toMatch(/foreign key|violates/i);
  });

  it("a cost with NO supplier can never be settled (a fuel receipt is not a payable)", async () => {
    const payment = await mkPayment(orgA, subA, 1_000);
    const ins = await svc().from("supplier_payment_allocations").insert({
      org_id: orgA,
      payment_id: payment,
      supplier_id: subA,
      finance_id: billNoSupplier,
      amount: 100,
    });
    expect(ins.error?.message ?? "").toMatch(/foreign key|bill_fk|violates/i);
  });

  it("a customer INVOICE cannot be an allocation target (structurally impossible)", async () => {
    const inv = await svc()
      .from("invoices")
      .insert({ org_id: orgA, number: `${T}-INV`, amount: 500, vat_total: 0, status: "sent" })
      .select("id")
      .single();
    expect(inv.error, inv.error?.message).toBeNull();

    const payment = await mkPayment(orgA, subA, 1_000);
    const ins = await svc().from("supplier_payment_allocations").insert({
      org_id: orgA,
      payment_id: payment,
      supplier_id: subA,
      finance_id: String(inv.data?.id), // an invoice id in the bill column
      amount: 100,
    });
    // `finance_id` references `finances`; an invoice id simply is not there, so
    // there is nothing to settle. TWO independent controls refuse this — the
    // guard's bill lookup and the composite bill FK — and the guard wins the
    // race because a BEFORE ROW trigger runs ahead of constraint checking. The
    // message therefore says "not found" rather than naming the FK; both are a
    // refusal, which is the property under test.
    expect(ins.error?.message ?? "").toMatch(/not found|foreign key|bill_fk|violates/i);

    const landed = await svc()
      .from("supplier_payment_allocations")
      .select("id")
      .eq("payment_id", payment);
    expect((landed.data ?? []).length, "nothing may be written against an invoice").toBe(0);
  });

  it("the RPC rolls the WHOLE payment back when a binding fails (atomic)", async () => {
    const before = await svc().from("supplier_payments").select("id").eq("org_id", orgA);
    const res = await asAdmin().rpc("record_supplier_payment", {
      p_org_id: orgA,
      p_supplier_id: subA,
      p_paid_at: "2026-07-02",
      p_method: "cash",
      p_reference: `${T}-ROLLBACK`,
      p_gross_amount: 500,
      p_cis_withheld: 0,
      p_notes: null,
      p_allocations: [{ finance_id: billMerch, amount: 100 }], // wrong supplier
    });
    expect(res.error).not.toBeNull();

    const after = await svc().from("supplier_payments").select("id").eq("org_id", orgA);
    expect(
      (after.data ?? []).length,
      "no orphan payment may survive a failed allocation",
    ).toBe((before.data ?? []).length);
  });

  // =========================================================================
  // 3. THE SETTLEMENT IDENTITY + CIS AUTHORITY
  // =========================================================================

  it("net_paid must equal gross − withheld (DB CHECK, every role)", async () => {
    const ins = await svc().from("supplier_payments").insert({
      org_id: orgA,
      supplier_id: subA,
      paid_at: "2026-07-01",
      gross_amount: 10_000,
      cis_withheld: 2_000,
      net_paid: 9_000, // lie
    });
    expect(ins.error?.message ?? "").toMatch(/settlement_identity|check|constraint/i);
  });

  it("you cannot withhold more than you settle", async () => {
    const ins = await svc().from("supplier_payments").insert({
      org_id: orgA,
      supplier_id: subA,
      paid_at: "2026-07-01",
      gross_amount: 100,
      cis_withheld: 200,
      net_paid: -100,
    });
    expect(ins.error?.message ?? "").toMatch(/check|constraint/i);
  });

  it("CIS cannot be withheld from a supplier with NO CIS record", async () => {
    const ins = await svc().from("supplier_payments").insert({
      org_id: orgA,
      supplier_id: merchA, // a builders' merchant
      paid_at: "2026-07-01",
      gross_amount: 400,
      cis_withheld: 80,
      net_paid: 320,
    });
    expect(ins.error?.message ?? "", "deducting tax from a merchant must be refused").toMatch(
      /CIS cannot be withheld/i,
    );
  });

  it("the same merchant CAN be paid normally with zero withheld (general payable path)", async () => {
    const res = await asAdmin().rpc("record_supplier_payment", {
      p_org_id: orgA,
      p_supplier_id: merchA,
      p_paid_at: "2026-07-03",
      p_method: "card",
      p_reference: `${T}-MERCH`,
      p_gross_amount: 400,
      p_cis_withheld: 0,
      p_notes: null,
      p_allocations: [{ finance_id: billMerch, amount: 400 }],
    });
    expect(res.error, res.error?.message).toBeNull();
  });

  // =========================================================================
  // 4. CAPS + CONCURRENCY
  // =========================================================================

  it("CAP 1 — Σ allocations may not exceed the payment", async () => {
    const payment = await mkPayment(orgA, subA, 100);
    const ok = await svc().from("supplier_payment_allocations").insert({
      org_id: orgA,
      payment_id: payment,
      supplier_id: subA,
      finance_id: billVat,
      amount: 100,
    });
    expect(ok.error, ok.error?.message).toBeNull();

    const bad = await svc().from("supplier_payment_allocations").insert({
      org_id: orgA,
      payment_id: payment,
      supplier_id: subA,
      finance_id: billA,
      amount: 1,
    });
    expect(bad.error?.message ?? "").toMatch(/over-allocated/i);
  });

  it("CAP 2 — Σ allocations may not exceed the BILL's gross (VAT included)", async () => {
    // billVat is 1000 net + 200 VAT = 1200 gross; 100 of it is already settled
    // by the CAP 1 test above, so 1100 remains.
    const payment = await mkPayment(orgA, subA, 5_000);
    const ok = await svc().from("supplier_payment_allocations").insert({
      org_id: orgA,
      payment_id: payment,
      supplier_id: subA,
      finance_id: billVat,
      amount: 1_100,
    });
    expect(ok.error, "the VAT-inclusive balance must be payable").toBeNull();

    const payment2 = await mkPayment(orgA, subA, 5_000);
    const bad = await svc().from("supplier_payment_allocations").insert({
      org_id: orgA,
      payment_id: payment2,
      supplier_id: subA,
      finance_id: billVat,
      amount: 0.02,
    });
    expect(bad.error?.message ?? "").toMatch(/over-paid/i);
  });

  it("a zero or negative allocation is refused", async () => {
    const payment = await mkPayment(orgA, subA, 100);
    const zero = await svc().from("supplier_payment_allocations").insert({
      org_id: orgA,
      payment_id: payment,
      supplier_id: subA,
      finance_id: billA,
      amount: 0,
    });
    expect(zero.error?.message ?? "").toMatch(/check|constraint/i);
  });

  it("the same bill cannot be listed twice on one payment", async () => {
    const payment = await mkPayment(orgA, subA, 100);
    const bill = await mkBill(orgA, subA, 100, 0);
    const first = await svc().from("supplier_payment_allocations").insert({
      org_id: orgA,
      payment_id: payment,
      supplier_id: subA,
      finance_id: bill,
      amount: 10,
    });
    expect(first.error, first.error?.message).toBeNull();
    const second = await svc().from("supplier_payment_allocations").insert({
      org_id: orgA,
      payment_id: payment,
      supplier_id: subA,
      finance_id: bill,
      amount: 10,
    });
    expect(second.error?.message ?? "").toMatch(/duplicate|unique|one_per_bill/i);
  });

  it("CONCURRENCY — two simultaneous allocations to ONE payment never exceed it", async () => {
    const bill = await mkBill(orgA, subA, 1_000, 0); // plenty of room on the bill
    const payment = await mkPayment(orgA, subA, 100);

    // Two £60 allocations to the SAME payment: £120 > £100. Exactly one may win.
    // Without the FOR UPDATE lock both would read "0 allocated" and both insert.
    // They target DIFFERENT bills so the unique key cannot be what stops them.
    const bill2 = await mkBill(orgA, subA, 1_000, 0);
    const fire = (finance: string) =>
      svc()
        .from("supplier_payment_allocations")
        .insert({
          org_id: orgA,
          payment_id: payment,
          supplier_id: subA,
          finance_id: finance,
          amount: 60,
        })
        .select("id")
        .single();

    const results = await Promise.allSettled([fire(bill), fire(bill2)]);
    const ok = results.filter(
      (r) => r.status === "fulfilled" && !(r.value as Res<Row>).error,
    ).length;
    expect(ok, "exactly one allocation may succeed").toBe(1);

    const rows = await svc()
      .from("supplier_payment_allocations")
      .select("amount")
      .eq("payment_id", payment);
    const total = (rows.data ?? []).reduce((s, r) => s + num(r.amount), 0);
    expect(total, "the ledger never exceeded the payment").toBe(60);
  });

  it("CONCURRENCY — two simultaneous payments cannot over-settle ONE bill", async () => {
    const bill = await mkBill(orgA, subA, 100, 0); // 100 gross
    const p1 = await mkPayment(orgA, subA, 100);
    const p2 = await mkPayment(orgA, subA, 100);

    const fire = (payment: string) =>
      svc()
        .from("supplier_payment_allocations")
        .insert({
          org_id: orgA,
          payment_id: payment,
          supplier_id: subA,
          finance_id: bill,
          amount: 60,
        })
        .select("id")
        .single();

    const results = await Promise.allSettled([fire(p1), fire(p2)]);
    const ok = results.filter(
      (r) => r.status === "fulfilled" && !(r.value as Res<Row>).error,
    ).length;
    expect(ok, "only one 60 fits inside a 100 bill twice over").toBe(1);

    const rows = await svc()
      .from("supplier_payment_allocations")
      .select("amount")
      .eq("finance_id", bill);
    const total = (rows.data ?? []).reduce((s, r) => s + num(r.amount), 0);
    expect(total).toBeLessThanOrEqual(100);
  });

  // =========================================================================
  // 5. IMMUTABILITY + CORRECTION
  // =========================================================================

  it("a recorded payment's money cannot be edited — by anyone", async () => {
    const payment = await mkPayment(orgA, subA, 500);
    for (const patch of [
      { gross_amount: 600 },
      { cis_withheld: 100 },
      { net_paid: 400 },
      { paid_at: "2026-01-01" },
      { supplier_id: merchA },
      { reference: "rewritten" },
    ]) {
      const upd = await svc().from("supplier_payments").update(patch).eq("id", payment);
      expect(upd.error?.message ?? "", `patching ${Object.keys(patch)[0]} must be refused`).toMatch(
        /immutable|check|constraint/i,
      );
    }

    const after = await svc()
      .from("supplier_payments")
      .select("gross_amount, supplier_id")
      .eq("id", payment)
      .maybeSingle();
    expect(num(after.data?.gross_amount)).toBe(500);
    expect(after.data?.supplier_id).toBe(subA);
  });

  it("notes stay editable — annotation is not the record", async () => {
    const payment = await mkPayment(orgA, subA, 500);
    const upd = await svc()
      .from("supplier_payments")
      .update({ notes: "cleared 3 days later" })
      .eq("id", payment);
    expect(upd.error, upd.error?.message).toBeNull();
  });

  it("a void needs a reason — a bare voided_at is refused", async () => {
    const payment = await mkPayment(orgA, subA, 500);
    const upd = await svc()
      .from("supplier_payments")
      .update({ voided_at: new Date().toISOString() })
      .eq("id", payment);
    expect(upd.error?.message ?? "", "an unexplained void must be refused").toMatch(
      /void_evidenced|check|constraint/i,
    );

    const blank = await svc()
      .from("supplier_payments")
      .update({ voided_at: new Date().toISOString(), void_reason: "   " })
      .eq("id", payment);
    expect(blank.error?.message ?? "").toMatch(/void_evidenced|check|constraint/i);
  });

  it("a void is ONE-WAY: a voided payment is terminal", async () => {
    const payment = await mkPayment(orgA, subA, 500);
    const done = await svc()
      .from("supplier_payments")
      .update({ voided_at: new Date().toISOString(), void_reason: "keyed wrong" })
      .eq("id", payment);
    expect(done.error, done.error?.message).toBeNull();

    const unvoid = await svc()
      .from("supplier_payments")
      .update({ voided_at: null, void_reason: null })
      .eq("id", payment);
    expect(unvoid.error?.message ?? "", "un-voiding must be refused").toMatch(
      /voided|final|check/i,
    );

    const renote = await svc().from("supplier_payments").update({ notes: "x" }).eq("id", payment);
    expect(renote.error?.message ?? "", "even a note cannot change on a voided row").toMatch(
      /voided|final|check/i,
    );
  });

  it("a voided payment cannot receive new allocations", async () => {
    const payment = await mkPayment(orgA, subA, 500);
    await svc()
      .from("supplier_payments")
      .update({ voided_at: new Date().toISOString(), void_reason: "cancelled" })
      .eq("id", payment);

    const ins = await svc().from("supplier_payment_allocations").insert({
      org_id: orgA,
      payment_id: payment,
      supplier_id: subA,
      finance_id: billA,
      amount: 1,
    });
    expect(ins.error?.message ?? "").toMatch(/voided/i);
  });

  it("allocations are frozen outright — no UPDATE", async () => {
    const bill = await mkBill(orgA, subA, 500, 0);
    const payment = await mkPayment(orgA, subA, 500);
    const ins = await svc()
      .from("supplier_payment_allocations")
      .insert({ org_id: orgA, payment_id: payment, supplier_id: subA, finance_id: bill, amount: 100 })
      .select("id")
      .single();
    expect(ins.error, ins.error?.message).toBeNull();

    const upd = await svc()
      .from("supplier_payment_allocations")
      .update({ amount: 1 })
      .eq("id", String(ins.data?.id));
    expect(upd.error?.message ?? "").toMatch(/immutable/i);
  });

  it("neither a payment nor an allocation can be DELETED — not even by service_role", async () => {
    const bill = await mkBill(orgA, subA, 500, 0);
    const payment = await mkPayment(orgA, subA, 500);
    const alloc = await svc()
      .from("supplier_payment_allocations")
      .insert({ org_id: orgA, payment_id: payment, supplier_id: subA, finance_id: bill, amount: 100 })
      .select("id")
      .single();

    const delAlloc = await svc()
      .from("supplier_payment_allocations")
      .delete()
      .eq("id", String(alloc.data?.id));
    expect(delAlloc.error?.message ?? "").toMatch(/cannot be deleted|void/i);

    const delPay = await svc().from("supplier_payments").delete().eq("id", payment);
    expect(delPay.error?.message ?? "").toMatch(/cannot be deleted|void/i);

    const still = await svc().from("supplier_payments").select("id").eq("id", payment).maybeSingle();
    expect(still.data, "the row must survive the attempt").not.toBeNull();
  });

  it("an admin cannot delete a payment either (RLS grants it; the guard refuses)", async () => {
    const payment = await mkPayment(orgA, subA, 25);
    await asAdmin().from("supplier_payments").delete().eq("id", payment);
    const still = await svc().from("supplier_payments").select("id").eq("id", payment).maybeSingle();
    expect(still.data).not.toBeNull();
  });

  it("a PAID bill cannot be deleted, and neither can a PAID supplier", async () => {
    const bill = await mkBill(orgA, subA, 500, 0);
    const payment = await mkPayment(orgA, subA, 500);
    await svc()
      .from("supplier_payment_allocations")
      .insert({ org_id: orgA, payment_id: payment, supplier_id: subA, finance_id: bill, amount: 500 });

    const delBill = await svc().from("finances").delete().eq("id", bill);
    expect(delBill.error?.message ?? "", "a settled bill must not vanish").toMatch(
      /foreign key|violates|referenced/i,
    );

    const delSupplier = await svc().from("suppliers").delete().eq("id", subA);
    expect(delSupplier.error?.message ?? "", "a paid supplier must not vanish").toMatch(
      /foreign key|violates|referenced/i,
    );
  });

  it("voiding FREES the bill's capacity so the corrected payment fits", async () => {
    const bill = await mkBill(orgA, subA, 1_000, 0);
    const wrong = await mkPayment(orgA, subA, 1_000);
    const a1 = await svc()
      .from("supplier_payment_allocations")
      .insert({ org_id: orgA, payment_id: wrong, supplier_id: subA, finance_id: bill, amount: 1_000 });
    expect(a1.error, a1.error?.message).toBeNull();

    // The bill is full: a second settlement is refused.
    const blocked = await mkPayment(orgA, subA, 1_000);
    const a2 = await svc()
      .from("supplier_payment_allocations")
      .insert({ org_id: orgA, payment_id: blocked, supplier_id: subA, finance_id: bill, amount: 1_000 });
    expect(a2.error?.message ?? "").toMatch(/over-paid/i);

    // Void the mistake, then the correction fits.
    await svc()
      .from("supplier_payments")
      .update({ voided_at: new Date().toISOString(), void_reason: "wrong amount" })
      .eq("id", wrong);

    const fixed = await mkPayment(orgA, subA, 1_000);
    const a3 = await svc()
      .from("supplier_payment_allocations")
      .insert({ org_id: orgA, payment_id: fixed, supplier_id: subA, finance_id: bill, amount: 1_000 });
    expect(a3.error, "the corrected payment must fit once the mistake is voided").toBeNull();

    // And the void is still on the record — nothing was erased.
    const voided = await svc()
      .from("supplier_payments")
      .select("void_reason")
      .eq("id", wrong)
      .maybeSingle();
    expect(voided.data?.void_reason).toBe("wrong amount");
  });

  it("an allocation-free payment IS removed when its organisation is deleted", async () => {
    // The delete guard's only escape hatch: teardown, told apart from a targeted
    // delete by the parent org already being invisible. Uses a throwaway org
    // with NO finances rows, because an org that has any `finances` row cannot
    // currently be deleted at all (see the afterAll note).
    const org = String(
      (await svc().from("organizations").insert({ name: "Teardown", slug: `${T}-td` }).select("id").single())
        .data?.id,
    );
    const supplier = String(
      (await svc().from("suppliers").insert({ org_id: org, name: `${T} TD` }).select("id").single()).data
        ?.id,
    );
    const payment = await mkPayment(org, supplier, 250);

    const del = await svc().from("organizations").delete().eq("id", org);
    expect(del.error, del.error?.message).toBeNull();

    const left = await svc().from("supplier_payments").select("id").eq("id", payment);
    expect((left.data ?? []).length, "the payment goes with its tenant").toBe(0);
  });

  // =========================================================================
  // 6. THE LOAD-BEARING INVARIANT — cost is unchanged by CIS withholding
  // =========================================================================

  it("recording a CIS payment does not change the job's cost or margin", async () => {
    const costOf = async () => {
      const rows = await svc().from("finances").select("job_id, amount, category").eq("job_id", jobA);
      return (rows.data ?? []).map((r) => ({
        job_id: String(r.job_id),
        amount: num(r.amount),
        category: (r.category ?? null) as string | null,
      }));
    };
    const invoices = [{ job_id: jobA, amount: 14_000 }];

    const financesBefore = await costOf();
    const before = computeJobProfitability(jobA, invoices, financesBefore);
    expect(before?.costs_total, "the £10,000 bill is the cost").toBe(10_000);

    // A £3,000 CIS payment against this job's subcontractor. (billA is already
    // fully settled by the first test, so this one sits on account — which is
    // the point: cash moves, cost does not.)
    const res = await asAdmin().rpc("record_supplier_payment", {
      p_org_id: orgA,
      p_supplier_id: subA,
      p_paid_at: "2026-07-10",
      p_method: "bank_transfer",
      p_reference: `${T}-INVARIANT`,
      p_gross_amount: 3_000,
      p_cis_withheld: 600,
      p_notes: null,
      p_allocations: [],
    });
    expect(res.error, res.error?.message).toBeNull();

    const financesAfter = await costOf();
    const after = computeJobProfitability(jobA, invoices, financesAfter);

    expect(after, "profitability must be byte-identical").toEqual(before);
    expect(after?.costs_total).toBe(10_000);
    expect(after?.gross_profit).toBe(4_000);
    // The wrong answer, spelled out: cash-based costing would show £4,600.
    expect(after?.gross_profit).not.toBe(4_600);
  });

  it("no `finances` row is created, altered or removed by the ledger", async () => {
    const snapshot = async () => {
      const rows = await svc()
        .from("finances")
        .select("id, amount, vat_rate, supplier_id, job_id, updated_at")
        .eq("org_id", orgA)
        .order("id");
      return JSON.stringify(rows.data ?? []);
    };

    const before = await snapshot();
    const bill = await mkBill(orgA, subA, 800, 20);
    const afterBill = await snapshot();
    expect(afterBill, "control: adding a bill DOES change finances").not.toBe(before);

    const res = await asAdmin().rpc("record_supplier_payment", {
      p_org_id: orgA,
      p_supplier_id: subA,
      p_paid_at: "2026-07-11",
      p_method: "bank_transfer",
      p_reference: `${T}-NOWRITE`,
      p_gross_amount: 960,
      p_cis_withheld: 160,
      p_notes: null,
      p_allocations: [{ finance_id: bill, amount: 960 }],
    });
    expect(res.error, res.error?.message).toBeNull();

    expect(
      await snapshot(),
      "recording a payment must leave every finances row byte-identical",
    ).toBe(afterBill);
  });

  it("H2-CASH is untouched: no money-IN row is created by a supplier payment", async () => {
    const countIn = async () => {
      const p = await svc().from("payments").select("id").eq("org_id", orgA);
      const ip = await svc().from("invoice_payments").select("id").eq("org_id", orgA);
      return [(p.data ?? []).length, (ip.data ?? []).length];
    };
    const before = await countIn();

    const res = await asAdmin().rpc("record_supplier_payment", {
      p_org_id: orgA,
      p_supplier_id: merchA,
      p_paid_at: "2026-07-12",
      p_method: "cash",
      p_reference: `${T}-CASHSEP`,
      p_gross_amount: 75,
      p_cis_withheld: 0,
      p_notes: null,
      p_allocations: [],
    });
    expect(res.error, res.error?.message).toBeNull();

    expect(await countIn(), "money-out must never touch the money-in ledger").toEqual(before);
  });

  it("the pure lib agrees with the database's own numbers", async () => {
    const bills = await svc()
      .from("finances")
      .select("id, amount, vat_total")
      .eq("org_id", orgA)
      .eq("supplier_id", subA);
    const payments = await svc()
      .from("supplier_payments")
      .select("id, paid_at, method, reference, gross_amount, cis_withheld, net_paid, voided_at")
      .eq("org_id", orgA)
      .eq("supplier_id", subA);
    const allocations = await svc()
      .from("supplier_payment_allocations")
      .select("payment_id, finance_id, amount")
      .eq("org_id", orgA)
      .eq("supplier_id", subA);

    const pos = computeSupplierPosition({
      bills: (bills.data ?? []) as never,
      payments: (payments.data ?? []) as never,
      allocations: (allocations.data ?? []) as never,
    });

    // Ground truth straight from SQL, computed independently of the lib.
    const liveIds = new Set(
      (payments.data ?? []).filter((p) => !p.voided_at).map((p) => String(p.id)),
    );
    const sqlNetCash = (payments.data ?? [])
      .filter((p) => !p.voided_at)
      .reduce((s, p) => s + num(p.net_paid), 0);
    const sqlWithheld = (payments.data ?? [])
      .filter((p) => !p.voided_at)
      .reduce((s, p) => s + num(p.cis_withheld), 0);
    const sqlSettled = (allocations.data ?? [])
      .filter((a) => liveIds.has(String(a.payment_id)))
      .reduce((s, a) => s + num(a.amount), 0);
    const sqlCost = (bills.data ?? []).reduce((s, b) => s + num(b.amount), 0);

    expect(pos.netCash).toBeCloseTo(sqlNetCash, 2);
    expect(pos.cisWithheld).toBeCloseTo(sqlWithheld, 2);
    expect(pos.settled).toBeCloseTo(sqlSettled, 2);
    // The cost figure is Σ finances.amount and nothing else: it matches SQL's
    // own sum over `finances` ALONE, with no term drawn from the payment ledger.
    expect(pos.billedNet).toBeCloseTo(sqlCost, 2);
    expect(pos.cisWithheld, "and withholding really did happen in this fixture").toBeGreaterThan(0);
    expect(
      pos.billedNet,
      "cost is not net-of-withholding — that would be sqlCost − sqlWithheld",
    ).not.toBeCloseTo(sqlCost - sqlWithheld, 2);
  });
});
