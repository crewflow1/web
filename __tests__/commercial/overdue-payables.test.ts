import { describe, it, expect } from "vitest";
import {
  composeOverduePayables,
  billDueDate,
  effectiveTermsDays,
  DEFAULT_PAYMENT_TERMS_DAYS,
} from "@/lib/commercial/overdue-payables";
import { composeAgedCreditors, type CreditorBill } from "@/lib/commercial/aged-creditors";
import { computeOrgCashOut, type CashOutBillRow } from "@/lib/commercial/cash-out";
import { AGEING_BUCKETS } from "@/lib/commercial/ageing";
import { round2 } from "@/lib/money";
import type { SupplierPaymentRow } from "@/lib/suppliers/payments";

/**
 * OVERDUE PAYABLES — TRUE due-date ageing, and the reconciliation that keeps it
 * honest.
 *
 * This closes the gap aged creditors documented: with `suppliers.payment_terms_days`
 * (migration 20261088) a bill's due date is `bill_date + terms`, so "overdue"
 * means the agreed deadline was missed — not merely that time has passed since the
 * bill was raised. The interesting cases are the ones that would mislead a builder
 * about who to pay: a bill still WITHIN terms reading as overdue, an unrecorded
 * term silently fabricating a deadline, and a BST-boundary date ageing a day early.
 *
 * The reconciliation block is the load-bearing half: re-slicing the SAME payable
 * by a different date must not change how much is owed. Payables ageing total ===
 * aged-creditors total === computeOrgCashOut().unpaidBills, over a matrix that
 * includes part-paid, settled and over-paid bills across several terms.
 */

// A frozen BST instant → a fixed as-at day. British Summer Time is in force on
// 2026-07-30, which is exactly what makes the London-day boundary case below bite.
const AS_AT = "2026-07-30";

function bill(over: Partial<CreditorBill> = {}): CreditorBill {
  return {
    id: "bill-1",
    amount: 1000, // NET
    vat_total: 200, // → £1,200 gross, what the supplier is actually owed
    reference: "SUP-1",
    bill_date: "2026-07-01",
    created_at: "2026-07-01T10:00:00Z",
    supplier_id: "sup-1",
    ...over,
  };
}

function payment(over: Partial<SupplierPaymentRow> = {}): SupplierPaymentRow {
  return {
    id: "pay-1",
    paid_at: "2026-07-10",
    method: "bank_transfer",
    reference: null,
    gross_amount: 500,
    cis_withheld: 0,
    net_paid: 500,
    voided_at: null,
    ...over,
  };
}

const NAMES = new Map([
  ["sup-1", "Travis Perkins"],
  ["sup-2", "Jewson"],
]);

function compose(input: {
  bills: CreditorBill[];
  payments?: SupplierPaymentRow[];
  allocations?: Array<{ payment_id: string; finance_id: string; amount: number }>;
  terms?: Map<string, number | null>;
}) {
  return composeOverduePayables(
    {
      bills: input.bills,
      payments: input.payments ?? [],
      allocations: input.allocations ?? [],
      supplierName: NAMES,
      termsBySupplier: input.terms ?? new Map(),
    },
    AS_AT,
  );
}

// ---------------------------------------------------------------------------
// The terms → due-date primitives
// ---------------------------------------------------------------------------

describe("effectiveTermsDays — a null term is the disclosed default, never a stored one", () => {
  it("uses the recorded value when present", () => {
    expect(effectiveTermsDays(60)).toBe(60);
    expect(effectiveTermsDays(0)).toBe(0); // net-0 (due on receipt) is legitimate
  });

  it("falls back to the default for null / undefined / nonsense", () => {
    expect(effectiveTermsDays(null)).toBe(DEFAULT_PAYMENT_TERMS_DAYS);
    expect(effectiveTermsDays(undefined)).toBe(DEFAULT_PAYMENT_TERMS_DAYS);
    expect(effectiveTermsDays(Number.NaN)).toBe(DEFAULT_PAYMENT_TERMS_DAYS);
    expect(effectiveTermsDays(-5)).toBe(DEFAULT_PAYMENT_TERMS_DAYS);
  });

  it("the documented default is 30", () => {
    expect(DEFAULT_PAYMENT_TERMS_DAYS).toBe(30);
  });
});

describe("billDueDate — bill date plus terms, London-pinned, undated when it must be", () => {
  it("adds recorded terms to the bill date", () => {
    expect(billDueDate(bill({ bill_date: "2026-06-01" }), new Map([["sup-1", 60]]))).toBe(
      "2026-07-31",
    );
  });

  it("applies the 30-day default when the supplier has no recorded term", () => {
    expect(billDueDate(bill({ bill_date: "2026-06-01" }), new Map())).toBe("2026-07-01");
    expect(billDueDate(bill({ bill_date: "2026-06-01" }), new Map([["sup-1", null]]))).toBe(
      "2026-07-01",
    );
  });

  it("falls back to the row's LONDON calendar day when bill_date is null", () => {
    // 23:30 UTC on 30 June is 00:30 BST on 1 July. The London day is the base, so
    // with net-0 terms the due date is 1 July, not 30 June — a UTC base would age
    // it a day early. This is the repo's BST-incident discipline.
    const due = billDueDate(
      bill({ bill_date: null, created_at: "2026-06-30T23:30:00Z" }),
      new Map([["sup-1", 0]]),
    );
    expect(due).toBe("2026-07-01");
  });

  it("is null when the bill has no datable base at all — it cannot be overdue", () => {
    expect(
      billDueDate(bill({ bill_date: null, created_at: null }), new Map([["sup-1", 0]])),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ageing by TRUE due date
// ---------------------------------------------------------------------------

describe("the bands — days PAST DUE, closed on the right", () => {
  it("a bill still within terms is current, not overdue", () => {
    // Billed 1 July, net-30 → due 31 July, and today is 30 July.
    const ledger = compose({ bills: [bill({ bill_date: "2026-07-01" })], terms: new Map([["sup-1", 30]]) });
    expect(ledger.totals.buckets.current).toBe(1200);
    expect(ledger.totals.pastDue).toBe(0);
  });

  it("due exactly today is current; due yesterday is 1 day late", () => {
    const t0 = new Map([["sup-1", 0]]);
    expect(compose({ bills: [bill({ bill_date: AS_AT })], terms: t0 }).totals.buckets.current).toBe(
      1200,
    );
    expect(
      compose({ bills: [bill({ bill_date: "2026-07-29" })], terms: t0 }).totals.buckets.d1_30,
    ).toBe(1200);
  });

  it("buckets by days past due, with the boundaries closed on the right", () => {
    // net-0 terms so due date === bill date, isolating the band arithmetic.
    const t0 = new Map([["sup-1", 0]]);
    const ledger = compose({
      bills: [
        bill({ id: "d30", bill_date: "2026-06-30" }), // 30 days late
        bill({ id: "d31", bill_date: "2026-06-29" }), // 31 days late
        bill({ id: "d60", bill_date: "2026-05-31" }), // 60 days late
        bill({ id: "d90", bill_date: "2026-05-01" }), // 90 days late
        bill({ id: "d91", bill_date: "2026-04-30" }), // 91 days late
      ],
      terms: t0,
    });
    const row = ledger.rows[0]!;
    expect(row.buckets.d1_30).toBe(1200); // exactly 30 → 1–30
    expect(row.buckets.d31_60).toBe(2400); // 31 and 60 → 31–60
    expect(row.buckets.d61_90).toBe(1200); // 90 → 61–90
    expect(row.buckets.d91_plus).toBe(1200); // 91 → 90+
  });

  it("longer recorded terms push a bill back toward current; the default does not", () => {
    // Same bill, two suppliers: one on net-60 (still within terms → current), one
    // with no recorded term (assumed 30 → already 15 days late).
    const b = bill({ bill_date: "2026-06-15" });
    const onTerms = compose({ bills: [b], terms: new Map([["sup-1", 60]]) });
    const assumed = compose({ bills: [b], terms: new Map([["sup-1", null]]) });
    expect(onTerms.totals.buckets.current).toBe(1200);
    expect(onTerms.totals.pastDue).toBe(0);
    expect(assumed.totals.buckets.d1_30).toBe(1200); // due 15 July → 15 days late
  });

  it("ages the item's dateIso to the DUE date, London-pinned, and reports the age", () => {
    // bill_date null, created_at 23:30 BST → London base 1 July, net-0 → due 1 July.
    const ledger = compose({
      bills: [bill({ bill_date: null, created_at: "2026-06-30T23:30:00Z" })],
      terms: new Map([["sup-1", 0]]),
    });
    const item = ledger.rows[0]!.items[0]!;
    expect(item.dateIso).toBe("2026-07-01");
    expect(item.ageDays).toBe(29); // 1 July → 30 July
  });

  it("an undated bill is disclosed as undated and can never be overdue", () => {
    const ledger = compose({
      bills: [bill({ bill_date: null, created_at: null })],
      terms: new Map([["sup-1", 0]]),
    });
    expect(ledger.rows[0]!.items[0]!.ageDays).toBeNull();
    expect(ledger.totals.undated).toBe(1200);
    expect(ledger.totals.buckets.current).toBe(1200);
    expect(ledger.totals.pastDue).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation — the same payable, re-sliced, never a new figure
// ---------------------------------------------------------------------------

describe("reconciliation — true ageing re-slices the payable, it never changes it", () => {
  // A deliberately mixed book: unpaid, part-paid, fully settled (must drop),
  // over-allocated (capped per bill), undated, across several suppliers/terms.
  const bills: CreditorBill[] = [
    bill({ id: "b1", supplier_id: "sup-1", amount: 1000, vat_total: 200, bill_date: "2026-05-01" }),
    bill({ id: "b2", supplier_id: "sup-1", amount: 400, vat_total: 80, bill_date: "2026-07-20" }),
    bill({ id: "b3", supplier_id: "sup-2", amount: 5000, vat_total: 1000, bill_date: "2026-03-15" }),
    bill({ id: "b4", supplier_id: "sup-2", amount: 250, vat_total: 50, bill_date: null, created_at: null }),
    bill({ id: "b5", supplier_id: "sup-1", amount: 800, vat_total: 160, bill_date: "2026-06-01" }),
  ];
  const payments: SupplierPaymentRow[] = [
    payment({ id: "p1", gross_amount: 600, net_paid: 600 }),
    payment({ id: "p2", gross_amount: 6000, net_paid: 6000 }),
    // A VOIDED payment that must settle nothing.
    payment({ id: "p3", gross_amount: 960, net_paid: 960, voided_at: "2026-07-15T00:00:00Z" }),
  ];
  const allocations = [
    { payment_id: "p1", finance_id: "b1", amount: 600 }, // b1 part-paid: 1200 - 600 = 600
    { payment_id: "p2", finance_id: "b3", amount: 6000 }, // b3 fully settled → drops
    { payment_id: "p3", finance_id: "b5", amount: 960 }, // voided → b5 still owed in full
  ];

  // Two suppliers on different terms; supplier-2's terms are unrecorded → default.
  const terms = new Map<string, number | null>([
    ["sup-1", 45],
    ["sup-2", null],
  ]);

  const overdue = composeOverduePayables(
    { bills, payments, allocations, supplierName: NAMES, termsBySupplier: terms },
    AS_AT,
  );
  const byBillDate = composeAgedCreditors(
    { bills, payments, allocations, supplierName: NAMES },
    AS_AT,
  );

  const cashOutBills: CashOutBillRow[] = bills.map((b) => ({
    id: b.id,
    amount: b.amount,
    vat_total: b.vat_total,
    reference: b.reference ?? null,
    bill_date: b.bill_date ?? null,
    created_at: b.created_at ?? null,
    supplier_id: b.supplier_id,
    purchase_order_id: null,
  }));
  const cashOut = computeOrgCashOut({
    bills: cashOutBills,
    payments,
    allocations,
    purchaseOrders: [],
    payrollRuns: [],
    payrollLines: [],
    cisSnapshots: [],
    vatInvoicePayments: [],
    vatFinances: [],
    quarterStartIso: "2026-07-01",
    todayIso: AS_AT,
  });

  it("has a non-trivial book (a vacuous 0 === 0 would prove nothing)", () => {
    expect(overdue.totals.total).toBeGreaterThan(0);
    expect(overdue.totals.pastDue).toBeGreaterThan(0);
    expect(overdue.totals.buckets.current).toBeGreaterThan(0);
  });

  it("overdue-payables total === aged-creditors total (ageing date changes only the bucket)", () => {
    expect(overdue.totals.total).toBe(byBillDate.totals.total);
  });

  it("overdue-payables total === computeOrgCashOut().unpaidBills (the cash position's payable)", () => {
    expect(overdue.totals.total).toBe(cashOut.unpaidBills);
  });

  it("the five columns partition the whole payable", () => {
    const summed = AGEING_BUCKETS.reduce((acc, b) => round2(acc + overdue.totals.buckets[b]), 0);
    expect(summed).toBe(overdue.totals.total);
  });

  it("a fully settled bill is in neither ledger", () => {
    const ids = overdue.rows.flatMap((r) => r.items.map((i) => i.id));
    expect(ids).not.toContain("b3"); // settled by p2
  });

  it("a voided payment leaves its bill fully owed", () => {
    const b5 = overdue.rows.flatMap((r) => r.items).find((i) => i.id === "b5");
    expect(b5?.amount).toBe(960); // 800 + 160 gross, nothing settled
  });

  it("the reconciled total is INVARIANT under the terms chosen — terms move buckets, not the sum", () => {
    // Halve every term; the total must not move by a penny, only the bands.
    const other = composeOverduePayables(
      {
        bills,
        payments,
        allocations,
        supplierName: NAMES,
        termsBySupplier: new Map([
          ["sup-1", 5],
          ["sup-2", 120],
        ]),
      },
      AS_AT,
    );
    expect(other.totals.total).toBe(overdue.totals.total);
    // ...but the shape genuinely differs, so this isn't a no-op comparison.
    expect(other.totals.buckets).not.toEqual(overdue.totals.buckets);
  });
});
