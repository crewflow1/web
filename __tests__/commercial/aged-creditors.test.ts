import { describe, it, expect } from "vitest";
import {
  composeAgedCreditors,
  UNATTRIBUTED_SUPPLIER_LABEL,
  type CreditorBill,
} from "@/lib/commercial/aged-creditors";
import { computeSupplierPosition, type SupplierPaymentRow } from "@/lib/suppliers/payments";

/**
 * AGED CREDITORS — settlement comes from the supplier-payment authority, and
 * ageing from the bill date because this schema stores no supplier due date.
 *
 * The failure modes worth testing are the ones that would make a builder pay
 * money twice or chase a supplier who has been paid: a voided payment counting
 * as settlement, VAT dropping out of the payable figure, and an undated bill
 * disappearing into `current`.
 */

const AS_AT = "2026-07-30";

function bill(over: Partial<CreditorBill> = {}): CreditorBill {
  return {
    id: "bill-1",
    amount: 1000, // NET
    vat_total: 200, // → £1,200 gross, which is what the supplier is paid
    reference: "SUP-8891",
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
}) {
  return composeAgedCreditors(
    {
      bills: input.bills,
      payments: input.payments ?? [],
      allocations: input.allocations ?? [],
      supplierName: NAMES,
    },
    AS_AT,
  );
}

describe("what a supplier is actually owed", () => {
  it("ages the GROSS balance — VAT is part of what leaves the bank", () => {
    const ledger = compose({ bills: [bill()] });
    expect(ledger.totals.total).toBe(1200);
    // 2026-07-01 → 2026-07-30 is 29 days.
    expect(ledger.totals.buckets.d1_30).toBe(1200);
  });

  it("nets off an allocated payment, leaving only the remainder", () => {
    const ledger = compose({
      bills: [bill()],
      payments: [payment()],
      allocations: [{ payment_id: "pay-1", finance_id: "bill-1", amount: 500 }],
    });
    expect(ledger.totals.total).toBe(700);
  });

  it("a VOIDED payment settles nothing — the bill is still owed in full", () => {
    // Void is the only correction mechanism; if a voided payment reduced the
    // payable here, the corrected payment would look like a double payment.
    const ledger = compose({
      bills: [bill()],
      payments: [payment({ voided_at: "2026-07-11T00:00:00Z" })],
      allocations: [{ payment_id: "pay-1", finance_id: "bill-1", amount: 500 }],
    });
    expect(ledger.totals.total).toBe(1200);
  });

  it("a settled bill drops out entirely", () => {
    const ledger = compose({
      bills: [bill()],
      payments: [payment({ gross_amount: 1200, net_paid: 1200 })],
      allocations: [{ payment_id: "pay-1", finance_id: "bill-1", amount: 1200 }],
    });
    expect(ledger.rows).toHaveLength(0);
    expect(ledger.totals.total).toBe(0);
  });

  it("over-settling ONE bill never pays down another", () => {
    const ledger = compose({
      bills: [bill({ id: "b1" }), bill({ id: "b2" })],
      payments: [payment({ gross_amount: 2000, net_paid: 2000 })],
      allocations: [{ payment_id: "pay-1", finance_id: "b1", amount: 1500 }],
    });
    // b1 is capped at its own £1,200; b2 remains fully owed.
    expect(ledger.totals.total).toBe(1200);
    expect(ledger.rows[0]!.items.map((i) => i.id)).toEqual(["b2"]);
  });

  it("agrees with the supplier page's own outstanding figure", () => {
    // Both compose computeBillSettlements, so a divergence would mean one of
    // them stopped using the authority.
    const bills = [bill({ id: "b1" }), bill({ id: "b2", amount: 400, vat_total: 80 })];
    const payments = [payment()];
    const allocations = [{ payment_id: "pay-1", finance_id: "b1", amount: 500 }];
    const ledger = composeAgedCreditors(
      { bills, payments, allocations, supplierName: NAMES },
      AS_AT,
    );
    const position = computeSupplierPosition({ bills, payments, allocations });
    expect(ledger.totals.total).toBe(position.outstanding);
  });
});

describe("the ageing basis — bill date, because there is no due date", () => {
  it("buckets by days since the bill date, closed on the right", () => {
    const ledger = compose({
      bills: [
        bill({ id: "today", bill_date: AS_AT }),
        bill({ id: "d30", bill_date: "2026-06-30" }),
        bill({ id: "d31", bill_date: "2026-06-29" }),
        bill({ id: "d200", bill_date: "2026-01-11" }),
      ],
    });
    const row = ledger.rows[0]!;
    expect(row.buckets.current).toBe(1200); // raised today
    expect(row.buckets.d1_30).toBe(1200); // exactly 30 days
    expect(row.buckets.d31_60).toBe(1200); // 31 days
    expect(row.buckets.d91_plus).toBe(1200); // 200 days
  });

  it("a future-dated bill is `current`, never negative-aged", () => {
    const ledger = compose({ bills: [bill({ bill_date: "2026-12-01" })] });
    expect(ledger.totals.buckets.current).toBe(1200);
    expect(ledger.totals.pastDue).toBe(0);
  });

  it("falls back to the row's London calendar day when bill_date is null", () => {
    // 23:30 UTC on 30 June is 00:30 BST on 1 July — the London day is what the
    // operator saw, so a UTC-day fallback would age it a day early.
    const ledger = compose({
      bills: [bill({ bill_date: null, created_at: "2026-06-30T23:30:00Z" })],
    });
    expect(ledger.rows[0]!.items[0]!.dateIso).toBe("2026-07-01");
    expect(ledger.rows[0]!.items[0]!.ageDays).toBe(29);
  });

  it("a bill with no date at all is undated, and disclosed as such", () => {
    const ledger = compose({ bills: [bill({ bill_date: null, created_at: null })] });
    expect(ledger.rows[0]!.items[0]!.ageDays).toBeNull();
    expect(ledger.totals.undated).toBe(1200);
    expect(ledger.totals.buckets.current).toBe(1200);
  });
});

describe("supplier attribution", () => {
  it("groups by supplier id and labels from the name map", () => {
    const ledger = compose({
      bills: [bill({ id: "b1", supplier_id: "sup-1" }), bill({ id: "b2", supplier_id: "sup-2" })],
    });
    expect(ledger.rows.map((r) => r.partyName).sort()).toEqual(["Jewson", "Travis Perkins"]);
  });

  it("names an unknown supplier id rather than rendering a raw uuid", () => {
    const ledger = compose({ bills: [bill({ supplier_id: "sup-deleted" })] });
    expect(ledger.rows[0]!.partyName).toBe("Unnamed supplier");
  });

  it("still counts a bill whose supplier is null", () => {
    const ledger = compose({ bills: [bill({ supplier_id: null })] });
    expect(ledger.rows[0]!.partyName).toBe(UNATTRIBUTED_SUPPLIER_LABEL);
    expect(ledger.totals.total).toBe(1200);
  });

  it("links each row's items at the supplier the operator can act on", () => {
    const ledger = compose({ bills: [bill()] });
    expect(ledger.rows[0]!.items[0]!.href).toBe("/suppliers/sup-1");
  });
});
