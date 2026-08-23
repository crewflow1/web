import { describe, it, expect } from "vitest";
import {
  computeVatQuarter,
  type InvoicePaymentRow,
  type FinanceRow,
  type SupplierPaymentLedgerRow,
  type AccrualInvoiceRow,
} from "@/lib/tax/compute";

/**
 * CF-1 — VAT Cash Accounting Scheme: INPUT VAT (box 4) must be gated on supplier
 * PAYMENT, not on the bill's tax point.
 *
 * UK VAT Cash Accounting Scheme (VAT Notice 731): a business accounts for BOTH
 * output tax AND input tax on the basis of PAYMENTS actually received/made — you
 * may only RECLAIM input VAT on a purchase invoice once you have PAID it. Before
 * this fix `computeVatQuarter` cash-based the output leg (invoice_payments ledger)
 * but summed input VAT from `finances` by tax point (created_at) regardless of
 * scheme — so a cash-scheme org with UNPAID purchase invoices reclaimed input VAT
 * too early and UNDERPAID HMRC. These fixtures prove the old behaviour is wrong and
 * the fixed behaviour is right, and that standard / FRS / reverse-charge are
 * untouched.
 */

// The Q1 return window used throughout: [2026-04-01, 2026-07-01).
const Q_START = "2026-04-01";
const Q_END = "2026-07-01";

/** A sales payment (gross cash received) for the cash-basis output-VAT ledger. */
function salePayment(
  paidAt: string | null,
  inv: { vat_total: number; amount: number; total: number },
): InvoicePaymentRow {
  return {
    amount: inv.total,
    paid_at: paidAt,
    invoice_vat_total: inv.vat_total,
    invoice_amount: inv.amount,
    invoice_total: inv.total,
  };
}

/** A PARTIAL sales payment: `cash` gross received against a larger invoice. */
function partialSalePayment(
  paidAt: string | null,
  cash: number,
  inv: { vat_total: number; amount: number; total: number },
): InvoicePaymentRow {
  return {
    amount: cash,
    paid_at: paidAt,
    invoice_vat_total: inv.vat_total,
    invoice_amount: inv.amount,
    invoice_total: inv.total,
  };
}

/** A supplier-payment allocation (gross settled against a bill) for the cash input-VAT ledger. */
function supplierAlloc(
  paidAt: string | null,
  a: { amount: number; bill_vat_total: number; bill_total: number },
): SupplierPaymentLedgerRow {
  return {
    amount: a.amount,
    paid_at: paidAt,
    bill_vat_total: a.bill_vat_total,
    bill_total: a.bill_total,
  };
}

// A purchase bill: £1,000 net + £200 VAT = £1,200 gross, logged (tax point) in Q1.
const BILL = { net: 1000, vat: 200, gross: 1200, created_at: "2026-04-12" };
const billFinance: FinanceRow = {
  vat_total: BILL.vat,
  amount: BILL.net,
  created_at: BILL.created_at,
};

describe("CF-1 — the bug: cash-scheme input VAT was accrual-based", () => {
  it("PROVES THE DEFECT: an UNPAID purchase invoice reclaims input VAT early on the accrual path", () => {
    // This is exactly what production does today: cash scheme, finance row logged
    // in the window, but NO supplier-payment ledger wired. The bill is UNPAID.
    // The accrual fallback reclaims the full £200 — money HMRC should still hold.
    const buggy = computeVatQuarter([], [billFinance], Q_START, Q_END, 0, {
      scheme: "cash",
    });
    expect(buggy.input_vat).toBe(200); // premature reclaim — the CF-1 defect
    expect(buggy.net_payable).toBe(-200); // a £200 refund the org is not owed yet
  });

  it("THE FIX: with the supplier-payment ledger, an UNPAID bill reclaims NOTHING", () => {
    // Same bill logged in-window, but the payment ledger has NO payment for it in
    // the window (it is unpaid). Under cash accounting box 4 must be £0.
    const fixed = computeVatQuarter([], [billFinance], Q_START, Q_END, 0, {
      scheme: "cash",
      supplierPayments: [], // no payments made this window
    });
    expect(fixed.input_vat).toBe(0);
    expect(fixed.net_payable).toBe(0);
  });
});

describe("CF-1 — cash-scheme INPUT VAT (box 4) purchase cases", () => {
  it("PAID purchase invoice: full input VAT reclaimed in the payment window", () => {
    const paid = [
      supplierAlloc("2026-05-10", { amount: BILL.gross, bill_vat_total: BILL.vat, bill_total: BILL.gross }),
    ];
    const r = computeVatQuarter([], [billFinance], Q_START, Q_END, 0, {
      scheme: "cash",
      supplierPayments: paid,
    });
    expect(r.input_vat).toBe(200);
    expect(r.net_payable).toBe(-200);
  });

  it("PARTIALLY-PAID purchase invoice: input VAT apportioned to the cash paid", () => {
    // £600 of a £1,200 bill paid ⇒ half the VAT = £100.
    const partial = [
      supplierAlloc("2026-05-10", { amount: 600, bill_vat_total: BILL.vat, bill_total: BILL.gross }),
    ];
    const r = computeVatQuarter([], [billFinance], Q_START, Q_END, 0, {
      scheme: "cash",
      supplierPayments: partial,
    });
    expect(r.input_vat).toBe(100);
  });

  it("MIXED PERIODS: bill logged in P1 but PAID in P2 reclaims in P2, not P1", () => {
    // Bill tax point 2026-04-12 (P1). Payment 2026-07-10 (P2 = the next quarter).
    const p2Payment = [
      supplierAlloc("2026-07-10", { amount: BILL.gross, bill_vat_total: BILL.vat, bill_total: BILL.gross }),
    ];
    // P1 window: nothing paid yet ⇒ box 4 = 0.
    const p1 = computeVatQuarter([], [billFinance], Q_START, Q_END, 0, {
      scheme: "cash",
      supplierPayments: p2Payment,
    });
    expect(p1.input_vat).toBe(0);
    // P2 window [2026-07-01, 2026-10-01): the payment lands ⇒ box 4 = 200.
    const p2 = computeVatQuarter([], [], "2026-07-01", "2026-10-01", 0, {
      scheme: "cash",
      supplierPayments: p2Payment,
    });
    expect(p2.input_vat).toBe(200);
  });

  it("PERIOD BOUNDARY: start inclusive, end exclusive on the payment date", () => {
    const onStart = [supplierAlloc(Q_START, { amount: BILL.gross, bill_vat_total: BILL.vat, bill_total: BILL.gross })];
    const onEnd = [supplierAlloc(Q_END, { amount: BILL.gross, bill_vat_total: BILL.vat, bill_total: BILL.gross })];
    expect(
      computeVatQuarter([], [], Q_START, Q_END, 0, { scheme: "cash", supplierPayments: onStart }).input_vat,
    ).toBe(200); // 2026-04-01 is INSIDE the window
    expect(
      computeVatQuarter([], [], Q_START, Q_END, 0, { scheme: "cash", supplierPayments: onEnd }).input_vat,
    ).toBe(0); // 2026-07-01 is the EXCLUSIVE upper bound — belongs to the next quarter
  });

  it("CIS-withheld bill: full VAT reclaimed on full settlement (withholding is not a cost)", () => {
    // A £1,200 gross CIS bill settled in full: allocation.amount is the GROSS
    // settled (£1,200) even though cash that left the bank was less after CIS
    // withholding. Input VAT is the full £200 — CIS never reduces reclaimable VAT.
    const cis = [
      supplierAlloc("2026-05-10", { amount: BILL.gross, bill_vat_total: BILL.vat, bill_total: BILL.gross }),
    ];
    const r = computeVatQuarter([], [billFinance], Q_START, Q_END, 0, {
      scheme: "cash",
      supplierPayments: cis,
    });
    expect(r.input_vat).toBe(200);
  });

  it("CREDIT NOTE / refund (non-positive bill total) is skipped, mirroring the sales side", () => {
    // A supplier credit note surfaces as a negative/zero-gross bill. The apportion
    // guard `bill_total <= 0` skips it — the SAME policy the output-VAT cash path
    // already applies to negative invoice totals, so both legs behave identically.
    const creditNote = [
      supplierAlloc("2026-05-10", { amount: -600, bill_vat_total: -100, bill_total: -600 }),
      supplierAlloc("2026-05-11", { amount: 0, bill_vat_total: 0, bill_total: 0 }),
    ];
    const r = computeVatQuarter([], [], Q_START, Q_END, 0, {
      scheme: "cash",
      supplierPayments: creditNote,
    });
    expect(r.input_vat).toBe(0);
  });
});

describe("CF-1 — cash-scheme OUTPUT VAT (box 1) sales cases are unchanged", () => {
  const inv = { vat_total: 200, amount: 1000, total: 1200 };

  it("UNPAID sales invoice contributes no output VAT (no payment row)", () => {
    const r = computeVatQuarter([], [], Q_START, Q_END, 0, {
      scheme: "cash",
      supplierPayments: [],
    });
    expect(r.output_vat).toBe(0);
  });

  it("PAID sales invoice contributes its output VAT in the payment window", () => {
    const r = computeVatQuarter([salePayment("2026-05-10", inv)], [], Q_START, Q_END, 0, {
      scheme: "cash",
      supplierPayments: [],
    });
    expect(r.output_vat).toBe(200);
  });

  it("PARTIALLY-PAID sales invoice apportions output VAT to cash received", () => {
    // £600 of a £1,200 invoice ⇒ £100 output VAT.
    const r = computeVatQuarter([partialSalePayment("2026-05-10", 600, inv)], [], Q_START, Q_END, 0, {
      scheme: "cash",
      supplierPayments: [],
    });
    expect(r.output_vat).toBe(100);
  });

  it("full picture: paid sale + paid purchase net correctly on cash", () => {
    const r = computeVatQuarter(
      [salePayment("2026-05-10", inv)],
      [billFinance],
      Q_START,
      Q_END,
      0,
      {
        scheme: "cash",
        supplierPayments: [
          supplierAlloc("2026-05-12", { amount: BILL.gross, bill_vat_total: BILL.vat, bill_total: BILL.gross }),
        ],
      },
    );
    expect(r.output_vat).toBe(200);
    expect(r.input_vat).toBe(200);
    expect(r.net_payable).toBe(0);
  });
});

describe("CF-1 — no regression: standard / FRS / reverse-charge / default", () => {
  const inv = { vat_total: 200, amount: 1000, total: 1200 };
  const accrual: AccrualInvoiceRow[] = [
    { status: "sent", tax_point: "2026-04-15", vat_total: 200, amount: 1000, total: 1200 },
  ];

  it("STANDARD scheme: input VAT stays ACCRUAL and IGNORES the supplier-payment ledger", () => {
    // Bill logged in-window but UNPAID. On standard (accrual) accounting box 4 is
    // reclaimable at the tax point regardless of payment — so £200, and the passed
    // supplierPayments ledger must have no effect on the standard path.
    const withLedger = computeVatQuarter([], [billFinance], Q_START, Q_END, 0, {
      scheme: "standard",
      accrualInvoices: accrual,
      supplierPayments: [], // present but must be ignored under standard
    });
    const withoutLedger = computeVatQuarter([], [billFinance], Q_START, Q_END, 0, {
      scheme: "standard",
      accrualInvoices: accrual,
    });
    expect(withLedger.input_vat).toBe(200);
    expect(withLedger).toEqual(withoutLedger); // ledger is inert under standard
  });

  it("FLAT RATE: box 4 stays the input-reclaim drop (0 + RC), ignoring the ledger", () => {
    const r = computeVatQuarter([salePayment("2026-05-10", inv)], [billFinance], Q_START, Q_END, 0, {
      scheme: "cash",
      flatRate: { applies: true, effectivePercent: 10 },
      supplierPayments: [
        supplierAlloc("2026-05-12", { amount: BILL.gross, bill_vat_total: BILL.vat, bill_total: BILL.gross }),
      ],
    });
    // FRS box 1 = 10% of gross turnover (£1,200) = £120; box 4 = 0 (no reclaim).
    expect(r.output_vat).toBe(120);
    expect(r.input_vat).toBe(0);
  });

  it("REVERSE CHARGE: net-neutral; RC bill (vat_total 0) adds nothing, notional VAT threads both legs", () => {
    // RC bill: supplier charges no VAT (bill_vat_total = 0), so the apportioned
    // input VAT is 0; the notional £200 enters box 1 AND box 4 via reverseChargeVat.
    const rcBill = [supplierAlloc("2026-05-10", { amount: 1000, bill_vat_total: 0, bill_total: 1000 })];
    const r = computeVatQuarter([], [], Q_START, Q_END, 200, {
      scheme: "cash",
      supplierPayments: rcBill,
    });
    expect(r.output_vat).toBe(200); // notional RC output
    expect(r.input_vat).toBe(200); // notional RC input (apportioned real input = 0)
    expect(r.net_payable).toBe(0); // net-neutral
  });

  it("DEFAULT (no scheme, no ledger) is byte-for-byte the pre-CF-1 accrual behaviour", () => {
    const bare = computeVatQuarter([salePayment("2026-05-10", inv)], [billFinance], Q_START, Q_END, 0);
    const explicitCashNoLedger = computeVatQuarter(
      [salePayment("2026-05-10", inv)],
      [billFinance],
      Q_START,
      Q_END,
      0,
      { scheme: "cash" }, // no supplierPayments ⇒ accrual fallback
    );
    expect(bare).toEqual(explicitCashNoLedger);
    expect(bare.output_vat).toBe(200);
    expect(bare.input_vat).toBe(200); // accrual finances fallback — unchanged
    expect(bare.net_payable).toBe(0);
  });
});
