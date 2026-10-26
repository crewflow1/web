import { afterAll, beforeAll, expect, it } from "vitest";
import { anonClient, describeIntegration, serviceClient, userClient } from "../_harness";
import { round2, toPounds } from "@/lib/money";
import { invoiceBusinessToday } from "@/lib/invoices/overdue";
import { composeAgedDebtors, type DebtorInvoice } from "@/lib/commercial/aged-debtors";
import { composeOverduePayables } from "@/lib/commercial/overdue-payables";
import type { CreditorBill } from "@/lib/commercial/aged-creditors";
import type { SupplierAllocationRow, SupplierPaymentRow } from "@/lib/suppliers/payments";
import {
  buildAgeingLedger,
  type AgeingItem,
  type AgeingLedger,
} from "@/lib/commercial/ageing";
import { computeOrgCashSummary, type OrgCashInvoice } from "@/lib/commercial/org-cash";
import { UNATTRIBUTED_CUSTOMER_LABEL } from "@/lib/commercial/aged-debtors";
import { UNATTRIBUTED_SUPPLIER_LABEL } from "@/lib/commercial/aged-creditors";

/**
 * R7 — AR/AP ageing via the org-guarded SECURITY DEFINER RPCs
 * (report_aged_receivables / report_aged_payables, migration 20261238000000),
 * against REAL Postgres.
 *
 * WHAT THIS PROVES
 * ----------------
 *  1. SNAPSHOT EQUALITY. The RPC path and the LEGACY whole-fetch + pure-bridge
 *     path produce byte-identical aged ledgers — over a cross-product of invoice
 *     status × settlement level × age band, including the cases a happy-path
 *     fixture never checks: a fully-settled invoice (excluded), a just-paid
 *     partially_paid invoice whose payments equal its total (excluded), an
 *     invoice with MULTIPLE partial payments, draft / paid / void (excluded by
 *     status), a null-customer invoice resolved via its job, a wholly
 *     unattributed invoice, and boundary ages at exactly 30 and 60 days.
 *  2. THE /cash IDENTITY. debtors.totals.total === computeOrgCashSummary.owedNow
 *     and debtors.totals.pastDue === computeOrgCashSummary.overdue, on the RPC
 *     path — the reconciliation the whole surface exists to preserve.
 *  3. THE PAYABLES ADMIN GATE. A non-admin MEMBER calling report_aged_payables
 *     is refused (42501) and gets NO payables data, while still being able to
 *     read receivables.
 *  4. THE MEMBERSHIP GUARD. A non-member calling report_aged_receivables for
 *     another org is refused (42501).
 */

type Row = Record<string, unknown>;
type Res = { data: Row[] | null; error: { message: string; code?: string } | null };
const dbRpc = (c: unknown) =>
  c as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<Res> };
const svcDb = (c: unknown) =>
  c as unknown as {
    from(t: string): {
      select(c: string): {
        eq(k: string, v: unknown): PromiseLike<Res> & { eq(k: string, v: unknown): PromiseLike<Res> };
      };
      insert(r: Row | Row[]): { select(c: string): { single(): PromiseLike<{ data: { id: string } | null }> } } & PromiseLike<Res>;
      delete(): { eq(k: string, v: unknown): PromiseLike<Res> };
    };
  };

const T = `it-r7age-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const NOW = new Date("2026-07-30T12:00:00Z");
const AS_AT = invoiceBusinessToday(NOW); // "2026-07-30"

// ── the service's own row→item mapping, reproduced as the oracle ──────────────
const sv = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => round2(toPounds(v as number | string | null));
const ageOf = (v: unknown): number | null => (v == null ? null : Number(v));
function debtorItem(r: Row): AgeingItem {
  const pid = sv(r.party_id);
  return {
    id: String(r.invoice_id),
    partyId: pid ?? "",
    partyName: pid ? sv(r.party_name) || "Unnamed customer" : UNATTRIBUTED_CUSTOMER_LABEL,
    amount: num(r.remaining),
    ageDays: ageOf(r.age_days),
    reference: sv(r.reference),
    dateIso: sv(r.due_date),
    href: `/invoices/${String(r.invoice_id)}`,
  };
}
function creditorItem(r: Row): AgeingItem {
  const pid = sv(r.party_id);
  return {
    id: String(r.bill_id),
    partyId: pid ?? "",
    partyName: pid ? sv(r.party_name) || "Unnamed supplier" : UNATTRIBUTED_SUPPLIER_LABEL,
    amount: num(r.outstanding),
    ageDays: ageOf(r.age_days),
    reference: sv(r.reference),
    dateIso: sv(r.date_iso),
    href: pid ? `/suppliers/${pid}` : "/expenses",
  };
}

describeIntegration("R7 aged-ledgers RPC · real Postgres", () => {
  let orgA = "";
  let orgB = "";
  let custA = "";
  let custNoName = "";
  let jobFallback = "";
  let supTerms = "";
  let supNoTerms = "";
  let admin = { id: "", token: "" };
  let member = { id: "", token: "" };
  let outsider = { id: "", token: "" };

  const svc = () => svcDb(serviceClient());

  async function mkUser(tag: string, org: string, role: string) {
    const email = `${T}-${tag}@x.test`;
    const created = await serviceClient().auth.admin.createUser({
      email,
      password: `Pw-${T}`,
      email_confirm: true,
    });
    const id = created.data.user?.id ?? "";
    await svc().from("users").insert({ id, email, full_name: tag });
    await svc().from("memberships").insert({ org_id: org, user_id: id, role });
    const s = await anonClient().auth.signInWithPassword({ email, password: `Pw-${T}` });
    return { id, token: s.data.session?.access_token ?? "" };
  }

  const insId = async (table: string, row: Row) =>
    String((await svc().from(table).insert(row).select("id").single()).data?.id);

  beforeAll(async () => {
    orgA = await insId("organizations", { name: "R7 A", slug: `${T}-a` });
    orgB = await insId("organizations", { name: "R7 B", slug: `${T}-b` });

    custA = await insId("customers", { org_id: orgA, name: "Acme Builders" });
    custNoName = await insId("customers", { org_id: orgA, name: "" }); // resolves but blank → "Unnamed customer"
    const custForJob = await insId("customers", { org_id: orgA, name: "Job-Linked Co" });
    jobFallback = await insId("jobs", { org_id: orgA, status: "new", customer_id: custForJob });

    // ── RECEIVABLES across every band + edge ────────────────────────────────
    // helper: insert an invoice (amount+vat → total) and optional payments.
    const inv = async (
      n: string,
      opts: { amount: number; vat: number; status: string; due: string | null; customer?: string | null; job?: string | null },
      payments: number[] = [],
    ) => {
      const id = await insId("invoices", {
        org_id: orgA,
        job_id: opts.job ?? null,
        customer_id: opts.customer === undefined ? custA : opts.customer,
        number: `${T}-${n}`,
        amount: opts.amount,
        vat_total: opts.vat,
        status: opts.status,
        due_date: opts.due,
      });
      for (const [i, p] of payments.entries()) {
        await svc()
          .from("invoice_payments")
          .insert({ org_id: orgA, invoice_id: id, amount: p, paid_at: `2026-07-${String(10 + i).padStart(2, "0")}` });
      }
      return id;
    };

    await inv("cur", { amount: 100, vat: 20, status: "sent", due: "2026-08-20" }); // not yet due → current+undated
    await inv("nodue", { amount: 50, vat: 10, status: "sent", due: null }); // no due date → current+undated
    await inv("d30", { amount: 200, vat: 40, status: "sent", due: "2026-06-30" }, [48]); // exactly 30 days late, partial
    await inv("d1_30", { amount: 300, vat: 60, status: "awaiting_payment", due: "2026-07-10" }); // 20 days
    await inv("d60", { amount: 400, vat: 80, status: "sent", due: "2026-05-31" }); // exactly 60
    await inv("d31_60", { amount: 150, vat: 30, status: "partially_paid", due: "2026-06-15" }, [40, 35]); // multi-partial, 45 days
    await inv("d61_90", { amount: 500, vat: 100, status: "sent", due: "2026-05-15" }); // 76 days
    await inv("d91", { amount: 1000, vat: 200, status: "sent", due: "2026-01-11" }); // ~200 days
    await inv("fallback", { amount: 90, vat: 18, status: "sent", due: "2026-07-01", customer: null, job: jobFallback }); // 29 days, job-resolved
    await inv("unattr", { amount: 70, vat: 14, status: "sent", due: "2026-07-01", customer: null, job: null }); // unattributed
    await inv("blankname", { amount: 60, vat: 12, status: "sent", due: "2026-07-05", customer: custNoName }); // "Unnamed customer"
    // excluded: fully settled, just-paid edge, draft, paid, void
    await inv("settled", { amount: 100, vat: 20, status: "partially_paid", due: "2026-07-01" }, [120]); // remaining 0 → excluded
    await inv("justpaid", { amount: 80, vat: 20, status: "partially_paid", due: "2026-06-01" }, [60, 40]); // 100 paid == total → excluded
    await inv("draft", { amount: 999, vat: 0, status: "draft", due: "2026-01-01" }); // not collectable
    await inv("paid", { amount: 999, vat: 0, status: "paid", due: "2026-01-01" }); // settled status
    await inv("void", { amount: 999, vat: 0, status: "void", due: "2026-01-01" }); // terminal

    // ── PAYABLES ────────────────────────────────────────────────────────────
    supTerms = await insId("suppliers", { org_id: orgA, name: "Timber Ltd", payment_terms_days: 30 });
    supNoTerms = await insId("suppliers", { org_id: orgA, name: "Nails Co" }); // null terms → default 30

    const bill = async (
      ref: string,
      opts: { amount: number; vat_rate: number; supplier: string | null; bill_date: string | null; created_at?: string },
    ) =>
      insId("finances", {
        org_id: orgA,
        amount: opts.amount,
        vat_rate: opts.vat_rate,
        supplier_id: opts.supplier,
        reference: ref,
        bill_date: opts.bill_date,
        ...(opts.created_at ? { created_at: opts.created_at } : {}),
      });

    // due = bill_date + 30. AS_AT 2026-07-30.
    const billCur = await bill("B-cur", { amount: 100, vat_rate: 20, supplier: supTerms, bill_date: "2026-07-20" }); // due 2026-08-19 → current
    const billD1_30 = await bill("B-30", { amount: 200, vat_rate: 20, supplier: supTerms, bill_date: "2026-06-10" }); // due 2026-07-10 → 20 days
    const billD31_60 = await bill("B-45", { amount: 300, vat_rate: 0, supplier: supNoTerms, bill_date: "2026-05-01" }); // due 2026-05-31 → 60? (0 vat)
    const billD91 = await bill("B-91", { amount: 400, vat_rate: 20, supplier: supTerms, bill_date: "2026-02-01" }); // due 2026-03-03 → ~149 days
    const billFallbackDate = await bill("B-nodate", { amount: 120, vat_rate: 20, supplier: supNoTerms, bill_date: null, created_at: "2026-07-01T10:00:00Z" }); // London 2026-07-01 +30 → 2026-07-31 → current(-1)
    const billSettled = await bill("B-settled", { amount: 500, vat_rate: 20, supplier: supTerms, bill_date: "2026-06-01" }); // will be fully paid → excluded
    const billVoided = await bill("B-voided", { amount: 250, vat_rate: 20, supplier: supTerms, bill_date: "2026-06-01" }); // only a voided payment → outstanding full
    const billNoSupplier = await bill("B-nosup", { amount: 90, vat_rate: 20, supplier: null, bill_date: "2026-06-01" }); // excluded (no supplier)

    // live payment that fully settles billSettled (gross = 500 + 100 = 600)
    const payLive = await insId("supplier_payments", {
      org_id: orgA,
      supplier_id: supTerms,
      paid_at: "2026-07-05",
      method: "bank_transfer",
      gross_amount: 600,
      cis_withheld: 0,
      net_paid: 600,
    });
    await svc().from("supplier_payment_allocations").insert({
      org_id: orgA,
      payment_id: payLive,
      supplier_id: supTerms,
      finance_id: billSettled,
      amount: 600,
    });
    // a live partial allocation against billD1_30 (gross 240) to exercise netting
    await svc().from("supplier_payment_allocations").insert({
      org_id: orgA,
      payment_id: payLive,
      supplier_id: supTerms,
      finance_id: billD1_30,
      amount: 40,
    });

    // voided payment whose allocation must settle NOTHING on billVoided
    const payVoid = await insId("supplier_payments", {
      org_id: orgA,
      supplier_id: supTerms,
      paid_at: "2026-07-06",
      method: "bank_transfer",
      gross_amount: 300,
      cis_withheld: 0,
      net_paid: 300,
      voided_at: "2026-07-07T00:00:00Z",
      void_reason: "test void",
    });
    await svc().from("supplier_payment_allocations").insert({
      org_id: orgA,
      payment_id: payVoid,
      supplier_id: supTerms,
      finance_id: billVoided,
      amount: 300,
    });

    // keep references used (lint: no-unused) — they anchor the seeded bands.
    void [billCur, billD31_60, billD91, billFallbackDate, billNoSupplier, billVoided];

    admin = await mkUser("admin", orgA, "admin");
    // A non-admin MEMBER of org A. The memberships role CHECK admits only
    // owner / admin / staff, so the non-admin member is seeded as `staff`: a
    // real member (can read receivables) who is NOT an org admin (is_org_admin
    // is false for staff, so the payables RPC must refuse them).
    member = await mkUser("member", orgA, "staff");
    outsider = await mkUser("outsider", orgB, "owner");
  });

  afterAll(async () => {
    if (orgA) await svc().from("organizations").delete().eq("id", orgA);
    if (orgB) await svc().from("organizations").delete().eq("id", orgB);
    for (const u of [admin, member, outsider]) {
      if (u.id) await serviceClient().auth.admin.deleteUser(u.id);
    }
  });

  // ── Build the LEGACY ground-truth ledgers from raw reads (service client) ───
  async function legacyLedgers(): Promise<{ debtors: AgeingLedger; creditors: AgeingLedger; cashInvoices: OrgCashInvoice[] }> {
    const s = svcDb(serviceClient());
    const inv = ((await s.from("invoices").select("id, number, status, total, due_date, customer_id, job_id").eq("org_id", orgA)) as Res).data ?? [];
    const pays = ((await s.from("invoice_payments").select("invoice_id, amount").eq("org_id", orgA)) as Res).data ?? [];
    const custs = ((await s.from("customers").select("id, name").eq("org_id", orgA)) as Res).data ?? [];
    const jobs = ((await s.from("jobs").select("id, customer_id").eq("org_id", orgA)) as Res).data ?? [];

    const paidByInvoice = new Map<string, number>();
    for (const p of pays) {
      const id = String(p.invoice_id);
      paidByInvoice.set(id, round2((paidByInvoice.get(id) ?? 0) + toPounds(p.amount as number | string | null)));
    }
    const invoices: DebtorInvoice[] = inv.map((i) => ({
      id: String(i.id),
      number: sv(i.number),
      status: String(i.status ?? ""),
      total: i.total as number | string | null,
      due_date: sv(i.due_date),
      customer_id: sv(i.customer_id),
      job_id: sv(i.job_id),
      paid: paidByInvoice.get(String(i.id)) ?? 0,
    }));
    const debtors = composeAgedDebtors(
      invoices,
      {
        customerName: new Map(custs.map((c) => [String(c.id), sv(c.name) ?? ""])),
        jobCustomer: new Map(jobs.map((j) => [String(j.id), sv(j.customer_id)])),
      },
      AS_AT,
    );

    const billRows = ((await s.from("finances").select("id, amount, vat_total, reference, bill_date, created_at, supplier_id").eq("org_id", orgA)) as Res).data ?? [];
    const apPayRows = ((await s.from("supplier_payments").select("id, voided_at").eq("org_id", orgA)) as Res).data ?? [];
    const allocRows = ((await s.from("supplier_payment_allocations").select("payment_id, finance_id, amount").eq("org_id", orgA)) as Res).data ?? [];
    const supRows = ((await s.from("suppliers").select("id, name, payment_terms_days").eq("org_id", orgA)) as Res).data ?? [];

    const bills: CreditorBill[] = billRows
      .filter((b) => b.supplier_id != null)
      .map((b) => ({
        id: String(b.id),
        amount: b.amount as number | string | null,
        vat_total: b.vat_total as number | string | null,
        reference: sv(b.reference),
        bill_date: sv(b.bill_date),
        created_at: sv(b.created_at),
        supplier_id: sv(b.supplier_id),
      }));
    const payments: SupplierPaymentRow[] = apPayRows.map((p) => ({
      id: String(p.id),
      paid_at: "",
      method: "",
      reference: null,
      gross_amount: null,
      cis_withheld: null,
      net_paid: null,
      voided_at: sv(p.voided_at),
    }));
    const allocations: SupplierAllocationRow[] = allocRows.map((a) => ({
      payment_id: String(a.payment_id),
      finance_id: String(a.finance_id),
      amount: a.amount as number | string | null,
    }));
    const creditors = composeOverduePayables(
      {
        bills,
        payments,
        allocations,
        supplierName: new Map(supRows.map((su) => [String(su.id), sv(su.name) ?? ""])),
        termsBySupplier: new Map(
          supRows.map((su) => {
            const raw = su.payment_terms_days;
            const n = raw == null ? null : Number(raw);
            return [String(su.id), n != null && Number.isFinite(n) ? n : null] as [string, number | null];
          }),
        ),
      },
      AS_AT,
    );

    const cashInvoices: OrgCashInvoice[] = invoices.map((i) => ({
      id: i.id,
      number: i.number,
      status: i.status,
      total: i.total,
      due_date: i.due_date,
      paid: i.paid,
      jobId: i.job_id,
      jobLabel: null,
    }));

    return { debtors, creditors, cashInvoices };
  }

  it("[snapshot] receivables: RPC path === legacy whole-fetch path", async () => {
    const { data, error } = await dbRpc(userClient(admin.token)).rpc("report_aged_receivables", {
      p_org_id: orgA,
      p_as_at: AS_AT,
    });
    expect(error, error?.message).toBeNull();
    const rpcLedger = buildAgeingLedger((data ?? []).map(debtorItem));
    const { debtors } = await legacyLedgers();
    expect(rpcLedger).toEqual(debtors);
    // sanity: the seed actually exercised multiple buckets
    const nonEmpty = Object.values(rpcLedger.totals.buckets).filter((v) => v > 0).length;
    expect(nonEmpty).toBeGreaterThanOrEqual(4);
  });

  it("[snapshot] payables: RPC path === legacy whole-fetch path (voided settles nothing)", async () => {
    const { data, error } = await dbRpc(userClient(admin.token)).rpc("report_aged_payables", {
      p_org_id: orgA,
      p_as_at: AS_AT,
    });
    expect(error, error?.message).toBeNull();
    const rpcLedger = buildAgeingLedger((data ?? []).map(creditorItem));
    const { creditors } = await legacyLedgers();
    expect(rpcLedger).toEqual(creditors);
  });

  it("[/cash identity] debtors total === owedNow and pastDue === overdue", async () => {
    const { data } = await dbRpc(userClient(admin.token)).rpc("report_aged_receivables", {
      p_org_id: orgA,
      p_as_at: AS_AT,
    });
    const rpcLedger = buildAgeingLedger((data ?? []).map(debtorItem));
    const { cashInvoices } = await legacyLedgers();
    const cash = computeOrgCashSummary({
      invoices: cashInvoices,
      retentionHeld: 0,
      retentionDueNow: 0,
      readyToInvoice: 0,
      now: NOW,
    });
    expect(rpcLedger.totals.total).toBe(cash.owedNow);
    expect(rpcLedger.totals.pastDue).toBe(cash.overdue);
  });

  it("[admin gate] a non-admin MEMBER is refused payables (42501) but can read receivables", async () => {
    const ap = await dbRpc(userClient(member.token)).rpc("report_aged_payables", { p_org_id: orgA, p_as_at: AS_AT });
    expect(ap.error, "non-admin must not read payables").not.toBeNull();
    expect(ap.error?.code === "42501" || /not an admin|admin-only|forbidden/i.test(ap.error?.message ?? "")).toBe(true);
    expect(ap.data ?? []).toEqual([]);

    const ar = await dbRpc(userClient(member.token)).rpc("report_aged_receivables", { p_org_id: orgA, p_as_at: AS_AT });
    expect(ar.error, "a member CAN read receivables").toBeNull();
    expect((ar.data ?? []).length).toBeGreaterThan(0);
  });

  it("[membership guard] a non-member is refused another org's receivables (42501)", async () => {
    const r = await dbRpc(userClient(outsider.token)).rpc("report_aged_receivables", { p_org_id: orgA, p_as_at: AS_AT });
    expect(r.error, "a non-member must not read org A").not.toBeNull();
    expect(r.error?.code === "42501" || /not a member|forbidden/i.test(r.error?.message ?? "")).toBe(true);
    expect(r.data ?? []).toEqual([]);
    // and the outsider is also refused payables for org A
    const p = await dbRpc(userClient(outsider.token)).rpc("report_aged_payables", { p_org_id: orgA, p_as_at: AS_AT });
    expect(p.error).not.toBeNull();
  });
});
