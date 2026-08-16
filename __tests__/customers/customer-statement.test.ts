import { describe, it, expect } from "vitest";
import {
  buildCustomerStatement,
  type StatementInvoiceInput,
  type StatementPaymentInput,
} from "@/lib/customers/statement";

/**
 * Statement-of-account maths — the running-balance authority.
 *
 * Proves: opening/closing balance netting, charge/credit running balance,
 * draft exclusion, payment-follows-its-invoice inclusion, deterministic
 * ordering (incl. same-day stability and charge-before-credit), date-range
 * boundaries (inclusive), and credit balances (overpayment → negative).
 */

const inv = (
  o: Partial<StatementInvoiceInput> & { id: string; created_at: string; total: number },
): StatementInvoiceInput => ({
  number: `INV-${o.id}`,
  status: "sent",
  due_date: null,
  ...o,
});

const pay = (
  o: Partial<StatementPaymentInput> & { id: string; invoice_id: string; paid_at: string; amount: number },
): StatementPaymentInput => ({
  reference: null,
  ...o,
});

describe("buildCustomerStatement — core ledger", () => {
  it("runs a balance forward: charges add, credits subtract", () => {
    const s = buildCustomerStatement(
      [
        inv({ id: "a", created_at: "2026-01-05T09:00:00Z", total: 1000 }),
        inv({ id: "b", created_at: "2026-02-10T09:00:00Z", total: 500 }),
      ],
      [pay({ id: "p1", invoice_id: "a", paid_at: "2026-01-20T09:00:00Z", amount: 400 })],
    );
    // Order: INV a (bal 1000), payment 400 (bal 600), INV b (bal 1100).
    expect(s.entries.map((e) => e.balance)).toEqual([1000, 600, 1100]);
    expect(s.openingBalance).toBe(0);
    expect(s.closingBalance).toBe(1100);
    expect(s.totalCharged).toBe(1500);
    expect(s.totalCredited).toBe(400);
    expect(s.invoiceCount).toBe(2);
    expect(s.paymentCount).toBe(1);
  });

  it("excludes DRAFT invoices entirely (never issued to the customer)", () => {
    const s = buildCustomerStatement(
      [
        inv({ id: "a", created_at: "2026-01-05T09:00:00Z", total: 1000, status: "draft" }),
        inv({ id: "b", created_at: "2026-01-06T09:00:00Z", total: 200, status: "sent" }),
      ],
      // A payment against the draft invoice must ALSO be excluded — a credit
      // with no matching charge would net a spurious negative.
      [pay({ id: "p1", invoice_id: "a", paid_at: "2026-01-10T09:00:00Z", amount: 50 })],
    );
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]!.reference).toBe("INV-b");
    expect(s.closingBalance).toBe(200);
    expect(s.totalCredited).toBe(0);
  });

  it("counts every issued status (partially_paid, awaiting_payment, paid, overdue)", () => {
    for (const status of ["sent", "awaiting_payment", "partially_paid", "paid", "overdue"]) {
      const s = buildCustomerStatement(
        [inv({ id: "a", created_at: "2026-01-05T09:00:00Z", total: 100, status })],
        [],
      );
      expect(s.invoiceCount, status).toBe(1);
      expect(s.totalCharged, status).toBe(100);
    }
  });
});

describe("buildCustomerStatement — ordering stability", () => {
  it("orders same-day: charge before credit, then by id", () => {
    const s = buildCustomerStatement(
      [
        inv({ id: "z-inv", created_at: "2026-03-01T15:00:00Z", total: 300 }),
        inv({ id: "a-inv", created_at: "2026-03-01T08:00:00Z", total: 100 }),
      ],
      [pay({ id: "p-first", invoice_id: "a-inv", paid_at: "2026-03-01T23:00:00Z", amount: 50 })],
    );
    // Both invoices are same-day charges (a-inv before z-inv by id), THEN the
    // same-day payment (credits after charges). Time-of-day is ignored.
    expect(s.entries.map((e) => e.reference)).toEqual(["INV-a-inv", "INV-z-inv", null]);
    expect(s.entries.map((e) => e.balance)).toEqual([100, 400, 350]);
  });

  it("is deterministic regardless of input order", () => {
    const invoices = [
      inv({ id: "b", created_at: "2026-02-01T00:00:00Z", total: 200 }),
      inv({ id: "a", created_at: "2026-01-01T00:00:00Z", total: 100 }),
    ];
    const payments = [pay({ id: "p", invoice_id: "a", paid_at: "2026-01-15T00:00:00Z", amount: 30 })];
    const s1 = buildCustomerStatement(invoices, payments);
    const s2 = buildCustomerStatement([...invoices].reverse(), [...payments]);
    expect(s1.entries.map((e) => e.balance)).toEqual(s2.entries.map((e) => e.balance));
    expect(s1.closingBalance).toBe(s2.closingBalance);
  });
});

describe("buildCustomerStatement — date range", () => {
  const invoices = [
    inv({ id: "a", created_at: "2025-12-01T00:00:00Z", total: 1000 }), // before range
    inv({ id: "b", created_at: "2026-01-15T00:00:00Z", total: 500 }), // in range
    inv({ id: "c", created_at: "2026-03-15T00:00:00Z", total: 700 }), // after range
  ];
  const payments = [
    pay({ id: "p0", invoice_id: "a", paid_at: "2025-12-10T00:00:00Z", amount: 200 }), // before
    pay({ id: "p1", invoice_id: "b", paid_at: "2026-01-20T00:00:00Z", amount: 100 }), // in
  ];

  it("folds pre-range movements into the opening balance", () => {
    const s = buildCustomerStatement(invoices, payments, { from: "2026-01-01", to: "2026-02-28" });
    // Opening = INV a 1000 − payment 200 = 800.
    expect(s.openingBalance).toBe(800);
    // In range: INV b (+500 → 1300), payment 100 (→ 1200). INV c dropped (after to).
    expect(s.entries.map((e) => e.reference)).toEqual(["INV-b", null]);
    expect(s.entries.map((e) => e.balance)).toEqual([1300, 1200]);
    expect(s.closingBalance).toBe(1200);
    expect(s.totalCharged).toBe(500);
    expect(s.totalCredited).toBe(100);
  });

  it("treats bounds as INCLUSIVE calendar days", () => {
    // to == the day INV b falls on → still included.
    const s = buildCustomerStatement(invoices, payments, { from: "2026-01-15", to: "2026-01-15" });
    // from folds INV a, payment p0 into opening (800). INV b is on 2026-01-15 (in).
    // payment p1 (2026-01-20) is after `to` → dropped.
    expect(s.openingBalance).toBe(800);
    expect(s.entries.map((e) => e.reference)).toEqual(["INV-b"]);
    expect(s.closingBalance).toBe(1300);
  });

  it("open-ended range (no bounds): opening 0, everything in range", () => {
    const s = buildCustomerStatement(invoices, payments);
    expect(s.openingBalance).toBe(0);
    expect(s.entries).toHaveLength(5);
    // 1000 −200 +500 −100 +700 = 1900.
    expect(s.closingBalance).toBe(1900);
  });

  it("ignores an invalid bound (treated as open-ended)", () => {
    const s = buildCustomerStatement(invoices, payments, { from: "not-a-date", to: "" });
    expect(s.from).toBeNull();
    expect(s.to).toBeNull();
    expect(s.openingBalance).toBe(0);
  });
});

describe("buildCustomerStatement — credit balances & rounding", () => {
  it("an overpayment drives a NEGATIVE (credit) balance", () => {
    const s = buildCustomerStatement(
      [inv({ id: "a", created_at: "2026-01-01T00:00:00Z", total: 100 })],
      [pay({ id: "p", invoice_id: "a", paid_at: "2026-01-02T00:00:00Z", amount: 150 })],
    );
    expect(s.closingBalance).toBe(-50);
  });

  it("rounds each step to 2dp (no float drift)", () => {
    const s = buildCustomerStatement(
      [
        inv({ id: "a", created_at: "2026-01-01T00:00:00Z", total: 0.1 }),
        inv({ id: "b", created_at: "2026-01-02T00:00:00Z", total: 0.2 }),
      ],
      [],
    );
    expect(s.closingBalance).toBe(0.3);
  });

  it("handles string/null money inputs via the money helpers", () => {
    const s = buildCustomerStatement(
      [inv({ id: "a", created_at: "2026-01-01T00:00:00Z", total: "250.50" as unknown as number })],
      [pay({ id: "p", invoice_id: "a", paid_at: "2026-01-02T00:00:00Z", amount: null as unknown as number })],
    );
    expect(s.totalCharged).toBe(250.5);
    expect(s.totalCredited).toBe(0);
    expect(s.closingBalance).toBe(250.5);
  });
});
