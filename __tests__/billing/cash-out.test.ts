import { describe, it, expect } from "vitest";
import {
  buildCashOutComponents,
  buildUnpaidBillQueue,
  computeCashPosition,
  computeOrgCashOut,
  type CashOutBillRow,
  type CashOutPoRow,
} from "@/lib/commercial/cash-out";
import { computeBillSettlements } from "@/lib/suppliers/payments";
import { computeVatQuarter, type InvoicePaymentRow } from "@/lib/tax/compute";
import { buildMonthlyReturnDataset } from "@/lib/cis/statements";
import { computeCommittedCosts } from "@/lib/purchase-orders/committed";
import { cisPaymentDueDate } from "@/lib/cis/tax-month";
import type { CisPaymentSnapshotRow } from "@/lib/cis/statements";
import type { SupplierAllocationRow, SupplierPaymentRow } from "@/lib/suppliers/payments";

/**
 * H2-CASH M4 — the money-OUT half of the cash position.
 *
 * These tests exist to prove TWO things, and they matter in this order:
 *
 *  1. Every figure is IDENTICAL to what the existing authority produces. Each
 *     block below recomputes its expectation by calling the authority directly
 *     (`computeBillSettlements`, `computeVatQuarter`, `buildMonthlyReturnDataset`,
 *     `computeCommittedCosts`) rather than hard-coding a number a second
 *     implementation could drift from. If someone ever inlines the maths here,
 *     the assertion still passes only while the two agree — and the source-level
 *     tripwire in __tests__/security/cash-out-no-new-arithmetic.test.ts refuses
 *     the inlining outright.
 *
 *  2. NOTHING IS COUNTED TWICE. The precedence (a supplier bill beats the
 *     purchase order that ordered it) is asserted directly, both ways round.
 */

const TODAY = "2026-07-30"; // CIS tax month 2026-07-06 → 2026-08-05, pay by 22 Aug
const QUARTER_START = "2026-07-01";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

const bill = (o: Partial<CashOutBillRow> & { id: string }): CashOutBillRow => ({
  id: o.id,
  supplier_id: o.supplier_id ?? "sup-1",
  purchase_order_id: o.purchase_order_id ?? null,
  amount: o.amount ?? 1000,
  vat_total: o.vat_total ?? 200,
  reference: o.reference ?? `REF-${o.id}`,
  bill_date: o.bill_date ?? "2026-07-01",
  category: o.category ?? "materials",
  job_id: o.job_id ?? null,
  created_at: o.created_at ?? "2026-07-01T00:00:00Z",
});

const payment = (o: Partial<SupplierPaymentRow> & { id: string }): SupplierPaymentRow => ({
  id: o.id,
  paid_at: o.paid_at ?? "2026-07-10",
  method: o.method ?? "bank_transfer",
  reference: o.reference ?? null,
  gross_amount: o.gross_amount ?? 0,
  cis_withheld: o.cis_withheld ?? 0,
  net_paid: o.net_paid ?? 0,
  voided_at: o.voided_at ?? null,
});

const alloc = (payment_id: string, finance_id: string, amount: number): SupplierAllocationRow => ({
  payment_id,
  finance_id,
  amount,
});

const po = (o: Partial<CashOutPoRow> & { id: string }): CashOutPoRow => ({
  id: o.id,
  number: o.number ?? `PO-${o.id}`,
  status: o.status ?? "sent",
  total: o.total ?? 0,
  supplier_id: o.supplier_id ?? "sup-1",
  expected_date: o.expected_date ?? null,
});

const snapshot = (
  o: Partial<CisPaymentSnapshotRow> & { payment_id: string; tax_month_end: string; cis_deduction: number },
): CisPaymentSnapshotRow => ({
  payment_id: o.payment_id,
  supplier_id: o.supplier_id ?? "sup-1",
  paid_at: o.paid_at ?? "2026-07-10",
  voided_at: o.voided_at ?? null,
  cis_status: o.cis_status ?? "standard_20",
  deduction_rate: o.deduction_rate ?? 20,
  verification_reference: o.verification_reference ?? null,
  legal_name: o.legal_name ?? "Sub Ltd",
  utr_masked: o.utr_masked ?? null,
  cis_gross_payment: o.cis_gross_payment ?? 5000,
  materials_total: o.materials_total ?? 0,
  cis_deduction: o.cis_deduction,
  tax_month_start: o.tax_month_start ?? "2026-07-06",
  tax_month_end: o.tax_month_end,
});

/** Everything empty — each block turns on exactly the input it is testing. */
const base = {
  bills: [] as CashOutBillRow[],
  payments: [] as SupplierPaymentRow[],
  allocations: [] as SupplierAllocationRow[],
  purchaseOrders: [] as CashOutPoRow[],
  payrollRuns: [] as Array<{ id: string; status: string; cycle: string | null; period_start: string | null; period_end: string | null }>,
  payrollLines: [] as Array<{ payroll_run_id: string; net_pay: number | string | null }>,
  cisSnapshots: [] as CisPaymentSnapshotRow[],
  vatInvoicePayments: [] as InvoicePaymentRow[],
  vatFinances: [] as Array<{ vat_total: number | string | null; amount: number | string | null; created_at: string }>,
  quarterStartIso: QUARTER_START,
  todayIso: TODAY,
};

/** A FULL payment of an invoice — the ledger sum equals the old full-amount path. */
function fp(
  paidAt: string | null,
  invoice: { vat_total: number; amount: number; total: number },
): InvoicePaymentRow {
  return {
    amount: invoice.total,
    paid_at: paidAt,
    invoice_vat_total: invoice.vat_total,
    invoice_amount: invoice.amount,
    invoice_total: invoice.total,
  };
}

// ---------------------------------------------------------------------------
// 1. Unpaid supplier bills — the settlement authority, unchanged
// ---------------------------------------------------------------------------

describe("computeOrgCashOut — unpaid supplier bills", () => {
  const bills = [
    bill({ id: "b1", amount: 1000, vat_total: 200 }), // gross 1200, unpaid
    bill({ id: "b2", amount: 2000, vat_total: 400 }), // gross 2400, £900 paid
    bill({ id: "b3", amount: 500, vat_total: 100 }), // gross 600, paid in full
  ];
  const payments = [payment({ id: "p1", gross_amount: 1500 })];
  const allocations = [alloc("p1", "b2", 900), alloc("p1", "b3", 600)];

  it("is Σ per-bill outstanding, straight from computeBillSettlements", () => {
    const out = computeOrgCashOut({ ...base, bills, payments, allocations });
    const authority = computeBillSettlements({ bills, payments, allocations });
    const expected = authority
      .filter((s) => s.outstanding > 0)
      .reduce((acc, s) => Math.round((acc + s.outstanding) * 100) / 100, 0);
    expect(out.unpaidBills).toBe(expected);
    expect(out.unpaidBills).toBe(2700); // 1200 + 1500
    expect(out.unpaidBillCount).toBe(2); // b3 is settled
  });

  it("counts a bill's GROSS (VAT included) — that is the cash the supplier is owed", () => {
    const out = computeOrgCashOut({ ...base, bills: [bill({ id: "x", amount: 1000, vat_total: 200 })] });
    expect(out.unpaidBills).toBe(1200);
  });

  it("a VOIDED payment settles nothing (the M2 void invariant survives the roll-up)", () => {
    const voided = [payment({ id: "p1", gross_amount: 1200, voided_at: "2026-07-11" })];
    const out = computeOrgCashOut({
      ...base,
      bills: [bill({ id: "b1", amount: 1000, vat_total: 200 })],
      payments: voided,
      allocations: [alloc("p1", "b1", 1200)],
    });
    expect(out.unpaidBills).toBe(1200);
  });

  it("over-settling one bill never pays down another (per-bill caps hold)", () => {
    // b3's £600 bill absorbs £600; the rest of the payment is on account.
    const out = computeOrgCashOut({
      ...base,
      bills: [bill({ id: "b1", amount: 1000, vat_total: 200 }), bill({ id: "b3", amount: 500, vat_total: 100 })],
      payments: [payment({ id: "p1", gross_amount: 5000 })],
      allocations: [alloc("p1", "b3", 600)],
    });
    expect(out.unpaidBills).toBe(1200); // b1 untouched
  });
});

// ---------------------------------------------------------------------------
// 2. VAT — the tax authority, unchanged, floored at zero
// ---------------------------------------------------------------------------

describe("computeOrgCashOut — VAT quarter", () => {
  // CASH-basis output VAT from the invoice_payments ledger: a full payment of a
  // £18,000 invoice (net £15,000 + £3,000 VAT) received in-quarter. A `sent`
  // invoice has no payment row, so it contributes nothing.
  const invoicePayments = [
    fp("2026-07-15", { vat_total: 3000, total: 18_000, amount: 15_000 }),
  ];
  const finances = [
    { vat_total: 400, amount: 2000, created_at: "2026-07-05T00:00:00Z" },
    { vat_total: 999, amount: 4995, created_at: "2026-03-01T00:00:00Z" }, // before the quarter
  ];

  it("is computeVatQuarter().net_payable — identical, not re-derived", () => {
    const out = computeOrgCashOut({ ...base, vatInvoicePayments: invoicePayments, vatFinances: finances });
    const authority = computeVatQuarter(invoicePayments, finances, QUARTER_START);
    expect(authority.net_payable).toBe(2600); // 3000 output − 400 input
    expect(out.vatDue).toBe(authority.net_payable);
    expect(out.vatReclaim).toBe(0);
  });

  it("passing the FULL row set gives the same answer as a pre-filtered one (the authority filters)", () => {
    // The service hands over every payment/finance row; computeVatQuarter applies
    // its own period predicate, so a pre-filtered set must agree — otherwise
    // /cash and /tax would print different VAT for the same quarter.
    const prefiltered = computeVatQuarter(
      invoicePayments.filter((p) => (p.paid_at ?? "") >= QUARTER_START),
      finances.filter((f) => f.created_at >= QUARTER_START),
      QUARTER_START,
    );
    const full = computeVatQuarter(invoicePayments, finances, QUARTER_START);
    expect(full).toEqual(prefiltered);
  });

  it("a VAT REFUND is reported as a reclaim, never as a negative outflow", () => {
    // Input VAT exceeds output: HMRC owes the builder. A negative outflow would
    // silently inflate the net position with an estimated refund.
    const out = computeOrgCashOut({
      ...base,
      vatInvoicePayments: [],
      vatFinances: [{ vat_total: 700, amount: 3500, created_at: "2026-07-05T00:00:00Z" }],
    });
    expect(out.vatDue).toBe(0);
    expect(out.vatReclaim).toBe(700);
    expect(out.outflowDueNow).toBe(0);
  });

  it("labels VAT as an estimate", () => {
    const out = computeOrgCashOut({ ...base, vatInvoicePayments: invoicePayments, vatFinances: finances });
    const row = buildCashOutComponents(out).find((r) => r.key === "vat_quarter");
    expect(row?.isEstimate).toBe(true);
    expect(out.outflowEstimated).toBe(out.vatDue);
  });
});

// ---------------------------------------------------------------------------
// 3. CIS — the frozen M3/M4 ledger, split by the HMRC payment deadline
// ---------------------------------------------------------------------------

describe("computeOrgCashOut — CIS due to HMRC", () => {
  // Current tax month (ends 5 Aug 2026) → pay by 22 Aug: deadline NOT passed.
  const current = snapshot({ payment_id: "p1", tax_month_end: "2026-08-05", cis_deduction: 1000 });
  // Two months back (ends 5 Jun 2026) → pay by 22 Jun: deadline passed.
  const old = snapshot({
    payment_id: "p2",
    tax_month_start: "2026-05-06",
    tax_month_end: "2026-06-05",
    paid_at: "2026-05-20",
    cis_deduction: 400,
  });

  it("classifies by cisPaymentDueDate, and the deadline dates are the authority's", () => {
    expect(cisPaymentDueDate("2026-08-05")).toBe("2026-08-22");
    expect(cisPaymentDueDate("2026-06-05")).toBe("2026-06-22");
    const out = computeOrgCashOut({ ...base, cisSnapshots: [current, old] });
    expect(out.cisDueNow).toBe(1000);
    expect(out.cisDueOn).toBe("2026-08-22");
    expect(out.cisPastDeadline).toBe(400);
  });

  it("the due figure equals buildMonthlyReturnDataset's total — not a second sum", () => {
    const authority = buildMonthlyReturnDataset([current, old], "2026-08-05");
    const out = computeOrgCashOut({ ...base, cisSnapshots: [current, old] });
    expect(out.cisDueNow).toBe(authority.totalDeduction);
  });

  it("past-deadline CIS is UNTRACKED and stays OUT of the position", () => {
    const out = computeOrgCashOut({ ...base, cisSnapshots: [old] });
    expect(out.cisPastDeadline).toBe(400);
    expect(out.outflowDueNow).toBe(0);
    const row = buildCashOutComponents(out).find((r) => r.key === "cis_past_deadline");
    expect(row?.certainty).toBe("UNTRACKED");
    expect(row?.inPosition).toBe(false);
    expect(row?.basis).toMatch(/no record of what you've paid HMRC/i);
  });

  it("a VOIDED payment's deduction is not a liability (the M4 population rule)", () => {
    const out = computeOrgCashOut({
      ...base,
      cisSnapshots: [{ ...current, voided_at: "2026-07-20" }],
    });
    expect(out.cisDueNow).toBe(0);
    expect(out.cisPastDeadline).toBe(0);
  });

  it("CIS due is NOT an estimate — it is a frozen tax fact", () => {
    const out = computeOrgCashOut({ ...base, cisSnapshots: [current] });
    const row = buildCashOutComponents(out).find((r) => r.key === "cis_hmrc");
    expect(row?.isEstimate).toBe(false);
    expect(row?.certainty).toBe("DUE");
    expect(out.outflowEstimated).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Payroll — DRAFT runs only, and labelled an estimate
// ---------------------------------------------------------------------------

describe("computeOrgCashOut — payroll", () => {
  const runs = [
    { id: "r1", status: "draft", cycle: "weekly", period_start: "2026-07-20", period_end: "2026-07-26" },
    { id: "r2", status: "finalised", cycle: "weekly", period_start: "2026-07-13", period_end: "2026-07-19" },
  ];
  const lines = [
    { payroll_run_id: "r1", net_pay: 812.34 },
    { payroll_run_id: "r1", net_pay: 655.11 },
    { payroll_run_id: "r2", net_pay: 900 },
  ];

  it("sums net_pay for DRAFT runs only — 'finalised' means LOCKED, not paid", () => {
    const out = computeOrgCashOut({ ...base, payrollRuns: runs, payrollLines: lines });
    expect(out.payrollDraft).toBe(1467.45);
    expect(out.payrollDraftRunCount).toBe(1);
  });

  it("is labelled an ESTIMATE and explains why employer costs are OUT by design", () => {
    // Net pay is the CORRECT cash figure, not a deficient one: employer NI and
    // PAYE/NI reach HMRC by the 22nd of the following month and pension goes to
    // the provider on its own date, so they are an accrual on a different clock.
    // The payroll lane's `payrollDueThisWeek` is net-pay-only for the same
    // reason; the wording here must not imply the number is short.
    const out = computeOrgCashOut({ ...base, payrollRuns: runs, payrollLines: lines });
    const row = buildCashOutComponents(out).find((r) => r.key === "payroll_draft");
    expect(row?.isEstimate).toBe(true);
    expect(row?.basis).toMatch(/employer NI/i);
    expect(row?.basis).toMatch(/pension/i);
    expect(row?.basis).toMatch(/PAYE\/NI/i);
    expect(row?.basis, "must not read as 'your figure is wrong'").not.toMatch(/INCOMPLETE/);
    expect(row?.basis, "must say why they are excluded").toMatch(/accrual/i);
    expect(out.outflowEstimated).toBe(out.payrollDraft);
  });

  it("never folds employer NI or pension into the cash-out total", () => {
    // A regression guard on the doctrine, not just the wording: the outflow is
    // net pay and nothing else from the payroll domain.
    const out = computeOrgCashOut({ ...base, payrollRuns: runs, payrollLines: lines });
    expect(out.payrollDraft).toBe(1467.45); // Σ net_pay, not Σ gross_pay
    expect(out.outflowDueNow).toBe(1467.45);
  });

  it("a line whose run we never read contributes nothing (no orphan liability)", () => {
    const out = computeOrgCashOut({
      ...base,
      payrollRuns: [],
      payrollLines: [{ payroll_run_id: "ghost", net_pay: 5000 }],
    });
    expect(out.payrollDraft).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. THE PRECEDENCE — a supplier bill beats the purchase order that ordered it
// ---------------------------------------------------------------------------

describe("computeOrgCashOut — committed spend never double-counts a billed PO", () => {
  it("a FULLY billed PO contributes ZERO committed spend; its money is in unpaid bills", () => {
    const out = computeOrgCashOut({
      ...base,
      purchaseOrders: [po({ id: "po1", status: "received", total: 1200 })],
      bills: [bill({ id: "b1", purchase_order_id: "po1", amount: 1000, vat_total: 200 })],
    });
    expect(out.unpaidBills).toBe(1200);
    expect(out.committedNotBilled).toBe(0);
    expect(out.committedPoCount).toBe(0);
    // Counted ONCE: the outflow is the bill, not the bill plus the order.
    expect(out.outflowDueNow).toBe(1200);
  });

  it("a PART billed PO commits only the un-invoiced remainder", () => {
    const out = computeOrgCashOut({
      ...base,
      purchaseOrders: [po({ id: "po1", status: "partially_received", total: 1200 })],
      bills: [bill({ id: "b1", purchase_order_id: "po1", amount: 500, vat_total: 100 })],
    });
    expect(out.unpaidBills).toBe(600);
    expect(out.committedNotBilled).toBe(600); // 1200 ordered − 600 invoiced
    // The two together equal the order exactly — no gap, no overlap.
    expect(out.unpaidBills + out.committedNotBilled).toBe(1200);
  });

  it("an UNBILLED PO is fully committed and NOT in unpaid bills", () => {
    const out = computeOrgCashOut({
      ...base,
      purchaseOrders: [po({ id: "po1", status: "sent", total: 1200 })],
    });
    expect(out.unpaidBills).toBe(0);
    expect(out.committedNotBilled).toBe(1200);
  });

  it("an OVER-billed PO commits nothing more (the floor is a floor, not a credit)", () => {
    const out = computeOrgCashOut({
      ...base,
      purchaseOrders: [po({ id: "po1", status: "received", total: 1000 })],
      bills: [bill({ id: "b1", purchase_order_id: "po1", amount: 1500, vat_total: 300 })],
    });
    expect(out.committedNotBilled).toBe(0);
    expect(out.unpaidBills).toBe(1800);
  });

  it("a CANCELLED PO commits nothing", () => {
    const out = computeOrgCashOut({
      ...base,
      purchaseOrders: [po({ id: "po1", status: "cancelled", total: 9999 })],
    });
    expect(out.committedNotBilled).toBe(0);
    expect(out.committed.committed).toBe(0);
  });

  it("keeps computeCommittedCosts' own buckets intact for the full commitment picture", () => {
    const pos = [
      po({ id: "a", status: "draft", total: 100 }),
      po({ id: "b", status: "sent", total: 200 }),
      po({ id: "c", status: "partially_received", total: 300 }),
      po({ id: "d", status: "received", total: 400 }),
      po({ id: "e", status: "cancelled", total: 500 }),
    ];
    const out = computeOrgCashOut({ ...base, purchaseOrders: pos });
    const authority = computeCommittedCosts(pos.map((p) => ({ status: p.status, total: p.total })));
    expect(out.committed).toEqual(authority);
  });

  it("committed spend is OUTSIDE the position — an order is not a liability", () => {
    const out = computeOrgCashOut({
      ...base,
      purchaseOrders: [po({ id: "po1", status: "sent", total: 5000 })],
    });
    expect(out.committedNotBilled).toBe(5000);
    expect(out.outflowDueNow).toBe(0);
    const row = buildCashOutComponents(out).find((r) => r.key === "committed_not_billed");
    expect(row?.certainty).toBe("COMMITTED");
    expect(row?.inPosition).toBe(false);
  });

  it("a bill with NO purchase order never suppresses another PO's commitment", () => {
    const out = computeOrgCashOut({
      ...base,
      purchaseOrders: [po({ id: "po1", status: "sent", total: 1200 })],
      bills: [bill({ id: "b1", purchase_order_id: null, amount: 1000, vat_total: 200 })],
    });
    expect(out.committedNotBilled).toBe(1200);
    expect(out.unpaidBills).toBe(1200);
  });
});

// ---------------------------------------------------------------------------
// 6. CIS withholding vs unpaid bills — disjoint by construction
// ---------------------------------------------------------------------------

describe("CIS withholding is not netted off a bill (withholding is not a cost saving)", () => {
  it("a part-paid CIS bill: the bill's own remaining balance is unaffected by the withholding", () => {
    // £12,000 gross bill. A payment settles £6,000 of it, £1,000 of which was
    // withheld for HMRC (so only £5,000 of cash left the bank). The bill's
    // outstanding is 12,000 − 6,000 = 6,000, NOT 6,000 + 1,000: the withheld
    // money still discharged the supplier's claim, it just went to HMRC instead.
    const bills = [bill({ id: "b1", amount: 10_000, vat_total: 2000 })];
    const payments = [payment({ id: "p1", gross_amount: 6000, cis_withheld: 1000, net_paid: 5000 })];
    const allocations = [alloc("p1", "b1", 6000)];
    const snaps = [snapshot({ payment_id: "p1", tax_month_end: "2026-08-05", cis_deduction: 1000 })];

    const out = computeOrgCashOut({ ...base, bills, payments, allocations, cisSnapshots: snaps });
    expect(out.unpaidBills).toBe(6000);
    expect(out.cisDueNow).toBe(1000);
    // The £1,000 is counted ONCE, as an HMRC liability — it is not also still
    // owed to the supplier, and it has not vanished.
    expect(out.outflowDueNow).toBe(7000);
    expect(out.billsSettled).toBe(6000);
  });
});

// ---------------------------------------------------------------------------
// 7. The position itself
// ---------------------------------------------------------------------------

describe("computeCashPosition", () => {
  it("is collectableNow − outflowDueNow", () => {
    const p = computeCashPosition({ collectableNow: 25_000, outflowDueNow: 9500, estimatedOutflow: 1500 });
    expect(p.net).toBe(15_500);
    expect(p.estimatedOutflow).toBe(1500);
    expect(p.hasEstimate).toBe(true);
  });

  it("goes NEGATIVE when you owe more than you can collect — a position, not a scoreboard", () => {
    const p = computeCashPosition({ collectableNow: 4000, outflowDueNow: 11_000, estimatedOutflow: 0 });
    expect(p.net).toBe(-7000);
    expect(p.hasEstimate).toBe(false);
  });

  it("caps the estimated share at the outflow and never reports a negative one", () => {
    expect(
      computeCashPosition({ collectableNow: 0, outflowDueNow: 100, estimatedOutflow: 999 }).estimatedOutflow,
    ).toBe(100);
    expect(
      computeCashPosition({ collectableNow: 0, outflowDueNow: 100, estimatedOutflow: -5 }).estimatedOutflow,
    ).toBe(0);
  });

  it("clamps nonsense inputs rather than propagating them into the headline", () => {
    const p = computeCashPosition({ collectableNow: -10, outflowDueNow: -10, estimatedOutflow: 0 });
    expect(p.collectableNow).toBe(0);
    expect(p.outflowDueNow).toBe(0);
    expect(p.net).toBe(0);
  });

  it("the outflow it consumes is EXACTLY computeOrgCashOut's — one definition, one number", () => {
    const out = computeOrgCashOut({
      ...base,
      bills: [bill({ id: "b1", amount: 1000, vat_total: 200 })],
      cisSnapshots: [snapshot({ payment_id: "p1", tax_month_end: "2026-08-05", cis_deduction: 300 })],
      payrollRuns: [{ id: "r1", status: "draft", cycle: "weekly", period_start: null, period_end: null }],
      payrollLines: [{ payroll_run_id: "r1", net_pay: 500 }],
    });
    const p = computeCashPosition({
      collectableNow: 3000,
      outflowDueNow: out.outflowDueNow,
      estimatedOutflow: out.outflowEstimated,
    });
    expect(out.outflowDueNow).toBe(2000); // 1200 + 300 + 500
    expect(p.net).toBe(1000);
    expect(p.estimatedOutflow).toBe(500); // the payroll estimate only
  });
});

// ---------------------------------------------------------------------------
// 8. The breakdown rows
// ---------------------------------------------------------------------------

describe("buildCashOutComponents", () => {
  it("always shows the payables row, even at zero ('£0 owed' is a statement)", () => {
    const rows = buildCashOutComponents(computeOrgCashOut(base));
    expect(rows.map((r) => r.key)).toEqual(["supplier_bills"]);
    expect(rows[0]!.amount).toBe(0);
  });

  it("orders rows most-certain-first and marks which ones are in the position", () => {
    const out = computeOrgCashOut({
      ...base,
      bills: [bill({ id: "b1", amount: 1000, vat_total: 200 })],
      cisSnapshots: [
        snapshot({ payment_id: "p1", tax_month_end: "2026-08-05", cis_deduction: 300 }),
        snapshot({ payment_id: "p2", tax_month_start: "2026-05-06", tax_month_end: "2026-06-05", cis_deduction: 90 }),
      ],
      vatInvoicePayments: [fp("2026-07-10", { vat_total: 500, total: 3000, amount: 2500 })],
      payrollRuns: [{ id: "r1", status: "draft", cycle: "weekly", period_start: null, period_end: null }],
      payrollLines: [{ payroll_run_id: "r1", net_pay: 400 }],
      purchaseOrders: [po({ id: "po1", status: "sent", total: 700 })],
    });
    const rows = buildCashOutComponents(out);
    expect(rows.map((r) => r.key)).toEqual([
      "supplier_bills",
      "cis_hmrc",
      "vat_quarter",
      "payroll_draft",
      "committed_not_billed",
      "cis_past_deadline",
    ]);
    // The rows marked inPosition must sum to EXACTLY outflowDueNow — the
    // breakdown reconciles to the headline by construction.
    const inPosition = rows.filter((r) => r.inPosition).reduce((a, r) => Math.round((a + r.amount) * 100) / 100, 0);
    expect(inPosition).toBe(out.outflowDueNow);
    // And the rows NOT in the position are exactly the two that cannot be.
    expect(rows.filter((r) => !r.inPosition).map((r) => r.key)).toEqual([
      "committed_not_billed",
      "cis_past_deadline",
    ]);
  });

  it("every row has a drill-through and a plain-English basis", () => {
    const out = computeOrgCashOut({
      ...base,
      bills: [bill({ id: "b1" })],
      cisSnapshots: [snapshot({ payment_id: "p1", tax_month_end: "2026-08-05", cis_deduction: 1 })],
      vatInvoicePayments: [fp("2026-07-10", { vat_total: 1, total: 6, amount: 5 })],
      payrollRuns: [{ id: "r1", status: "draft", cycle: null, period_start: null, period_end: null }],
      payrollLines: [{ payroll_run_id: "r1", net_pay: 1 }],
      purchaseOrders: [po({ id: "po1", status: "sent", total: 1 })],
    });
    for (const row of buildCashOutComponents(out)) {
      expect(row.href, row.key).toMatch(/^\//);
      expect(row.basis.length, row.key).toBeGreaterThan(30);
      expect(row.label.length, row.key).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. The payables queue
// ---------------------------------------------------------------------------

describe("buildUnpaidBillQueue", () => {
  const bills = [
    bill({ id: "b1", supplier_id: "s1", amount: 1000, vat_total: 200, bill_date: "2026-07-01" }),
    bill({ id: "b2", supplier_id: "s2", amount: 4000, vat_total: 800, bill_date: "2026-06-01" }),
    bill({ id: "b3", supplier_id: "s1", amount: 500, vat_total: 100, bill_date: "2026-05-01" }),
  ];
  const payments = [payment({ id: "p1", gross_amount: 600 })];
  const allocations = [alloc("p1", "b3", 600)];
  const names = new Map([
    ["s1", "Travis Perkins"],
    ["s2", "Jewson"],
  ]);

  it("lists only bills with something outstanding, biggest first, with a stable order", () => {
    const q = buildUnpaidBillQueue({ bills, payments, allocations, supplierNames: names });
    expect(q.map((i) => i.id)).toEqual(["b2", "b1"]);
    expect(q[0]!.outstanding).toBe(4800);
    expect(q[0]!.supplierName).toBe("Jewson");
    expect(q[0]!.href).toBe("/suppliers/s2/payments");
  });

  it("surfaces part-payment honestly (gross and outstanding both carried)", () => {
    const q = buildUnpaidBillQueue({
      bills: [bill({ id: "b1", supplier_id: "s1", amount: 1000, vat_total: 200 })],
      payments: [payment({ id: "p1", gross_amount: 400 })],
      allocations: [alloc("p1", "b1", 400)],
      supplierNames: names,
    });
    expect(q[0]!.gross).toBe(1200);
    expect(q[0]!.outstanding).toBe(800);
    expect(q[0]!.status).toBe("part_paid");
  });

  it("the queue's outstanding total reconciles with the summary's unpaidBills", () => {
    const q = buildUnpaidBillQueue({ bills, payments, allocations, supplierNames: names });
    const queueTotal = q.reduce((a, i) => Math.round((a + i.outstanding) * 100) / 100, 0);
    const out = computeOrgCashOut({ ...base, bills, payments, allocations });
    expect(queueTotal).toBe(out.unpaidBills);
  });

  it("a bill whose supplier we could not name still links somewhere useful", () => {
    const q = buildUnpaidBillQueue({
      bills: [bill({ id: "b1", supplier_id: "unknown" })],
      payments: [],
      allocations: [],
      supplierNames: new Map(),
    });
    expect(q[0]!.supplierName).toBeNull();
    expect(q[0]!.href).toBe("/suppliers/unknown/payments");
  });
});
