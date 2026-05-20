import { describe, it, expect } from "vitest";
import {
  addPaymentSchema,
  scoreInvoiceMatch,
  parseBankCsv,
} from "@/lib/payments/schema";

describe("addPaymentSchema", () => {
  it("accepts a minimal valid payment", () => {
    const r = addPaymentSchema.safeParse({
      amount: "150.50",
      paid_at: "2026-05-20",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.amount).toBe(150.5);
      expect(r.data.reference).toBeUndefined();
      expect(r.data.notes).toBeUndefined();
    }
  });

  it("rejects zero / negative amounts", () => {
    expect(addPaymentSchema.safeParse({ amount: 0, paid_at: "2026-05-20" }).success).toBe(false);
    expect(addPaymentSchema.safeParse({ amount: -10, paid_at: "2026-05-20" }).success).toBe(false);
  });

  it("rejects malformed dates", () => {
    expect(addPaymentSchema.safeParse({ amount: 10, paid_at: "20-05-2026" }).success).toBe(false);
    expect(addPaymentSchema.safeParse({ amount: 10, paid_at: "" }).success).toBe(false);
  });

  it("treats empty-string reference / notes as undefined", () => {
    const r = addPaymentSchema.safeParse({
      amount: 10,
      paid_at: "2026-05-20",
      reference: "   ",
      notes: "",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.reference).toBeUndefined();
      expect(r.data.notes).toBeUndefined();
    }
  });
});

describe("scoreInvoiceMatch", () => {
  const invoice = {
    id: "inv-1",
    number: "INV-001",
    total: 1200,
    sent_at: "2026-05-01T00:00:00Z",
    customer_name: "Acme Builders",
  };

  it("returns 0 for outgoing money (negative amount)", () => {
    expect(
      scoreInvoiceMatch(
        { amount: -1200, description: "INV-001 acme", reference: "INV-001", posted_at: "2026-05-02" },
        invoice,
      ),
    ).toBe(0);
  });

  it("scores an exact-amount + invoice-number + customer-name + date match very high", () => {
    const s = scoreInvoiceMatch(
      { amount: 1200, description: "Payment from Acme Builders", reference: "INV-001", posted_at: "2026-05-03" },
      invoice,
    );
    // 60 (exact amount) + 30 (number in ref) + 10 (customer name in desc) + 5 (date proximity)
    expect(s).toBe(100); // clamped to 100
  });

  it("rejects amounts more than 5% off", () => {
    const s = scoreInvoiceMatch(
      { amount: 100, description: "Acme Builders", reference: "INV-001", posted_at: "2026-05-03" },
      invoice,
    );
    expect(s).toBe(0);
  });

  it("awards a partial score for a near-amount match without other signals", () => {
    const s = scoreInvoiceMatch(
      { amount: 1199.5, description: null, reference: null, posted_at: "2026-05-03" },
      invoice,
    );
    // 40 (within £1) + 5 (date proximity) — no number, no customer name
    expect(s).toBe(45);
  });

  it("amount within 5% but not within £1 → 20 + extras", () => {
    const s = scoreInvoiceMatch(
      { amount: 1150, description: null, reference: null, posted_at: "2026-05-03" },
      invoice,
    );
    expect(s).toBe(25); // 20 (within 5%) + 5 (date)
  });

  it("is case-insensitive for invoice number matching", () => {
    const s = scoreInvoiceMatch(
      { amount: 1200, description: "lowercase inv-001 ref", reference: null, posted_at: "2026-05-03" },
      invoice,
    );
    // 60 (exact) + 30 (number in description) + 5 (date)
    expect(s).toBe(95);
  });

  it("ignores customer names shorter than 3 chars (avoids spurious 'AB' hits)", () => {
    const s = scoreInvoiceMatch(
      { amount: 1200, description: "ab", reference: null, posted_at: "2026-05-03" },
      { ...invoice, customer_name: "AB" },
    );
    // 60 (exact amount) + 5 (date) — no customer-name bonus
    expect(s).toBe(65);
  });

  it("no date bonus if invoice has no sent_at", () => {
    const s = scoreInvoiceMatch(
      { amount: 1200, description: null, reference: null, posted_at: "2026-05-03" },
      { ...invoice, sent_at: null },
    );
    expect(s).toBe(60); // exact amount only
  });
});

describe("parseBankCsv", () => {
  it("parses a simple CSV with date, amount, description columns", () => {
    const csv = `Date,Amount,Description
2026-05-01,1200.00,Acme Builders INV-001
2026-05-02,-30.50,Petrol station`;
    const rows = parseBankCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      posted_at: "2026-05-01",
      amount: 1200,
      description: "Acme Builders INV-001",
      reference: null,
    });
    expect(rows[1]!.amount).toBe(-30.5);
  });

  it("handles UK DD/MM/YYYY dates", () => {
    const csv = `Date,Amount,Description
01/05/2026,500,Test`;
    const rows = parseBankCsv(csv);
    expect(rows[0]!.posted_at).toBe("2026-05-01");
  });

  it("combines separate credit + debit columns into a signed amount", () => {
    const csv = `Date,Credit,Debit,Description
2026-05-01,1200,,Money in
2026-05-02,,30.50,Money out`;
    const rows = parseBankCsv(csv);
    expect(rows[0]!.amount).toBe(1200);
    expect(rows[1]!.amount).toBe(-30.5);
  });

  it("strips currency symbols + commas from amounts", () => {
    const csv = `Date,Amount,Description
2026-05-01,"£1,200.00","Big payment"`;
    const rows = parseBankCsv(csv);
    expect(rows[0]!.amount).toBe(1200);
    expect(rows[0]!.description).toBe("Big payment");
  });

  it("respects RFC4180-ish quoted cells (commas inside quotes)", () => {
    const csv = `Date,Amount,Description,Reference
2026-05-01,500,"Smith, John payment",REF-1`;
    const rows = parseBankCsv(csv);
    expect(rows[0]!.description).toBe("Smith, John payment");
    expect(rows[0]!.reference).toBe("REF-1");
  });

  it("throws on completely empty input", () => {
    expect(() => parseBankCsv("")).toThrow();
    expect(() => parseBankCsv("Date,Amount,Description")).toThrow(); // header only
  });

  it("throws when a required column is missing", () => {
    expect(() => parseBankCsv("Foo,Bar\n1,2")).toThrow(/date/i);
    expect(() => parseBankCsv("Date,Description\n2026-05-01,x")).toThrow(/amount/i);
  });

  it("skips rows with unparseable dates rather than aborting the whole import", () => {
    const csv = `Date,Amount,Description
2026-05-01,100,Good row
not-a-date,200,Bad row
2026-05-03,300,Another good row`;
    const rows = parseBankCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.amount)).toEqual([100, 300]);
  });
});
