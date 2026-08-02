import { describe, it, expect } from "vitest";
import {
  toCanonicalRows,
  money2,
  type CanonicalInvoiceInput,
  type CanonicalPaymentInput,
} from "@/lib/integrations/accounting/canonical";
import {
  toAccountingCsv,
  ACCOUNTING_CSV_COLUMNS,
} from "@/lib/integrations/accounting/csv";
import { capRows, MAX_ROWS } from "@/server/services/accounting-export";

/**
 * Accounting export — PURE mapper + CSV serialiser unit proofs.
 *
 * The mapper and the CSV are the deterministic heart of the export: exact rows
 * in, exact bytes out. These tests pin the money split (net / vat / gross), the
 * overdue-display derivation, payment handling, stable ordering, and RFC-4180
 * quoting including the awkward fields.
 */

const TODAY = "2026-08-01";

function inv(over: Partial<CanonicalInvoiceInput>): CanonicalInvoiceInput {
  return {
    number: "INV-0001",
    status: "sent",
    amount: 100,
    vat_total: 20,
    total: 120,
    due_date: "2026-09-01",
    sent_at: "2026-07-01T09:00:00Z",
    created_at: "2026-06-30T09:00:00Z",
    customer_name: "Acme Ltd",
    ...over,
  };
}

describe("money2 — fixed 2dp, never NaN", () => {
  it("formats numbers and decimal strings identically", () => {
    expect(money2(1234.5)).toBe("1234.50");
    expect(money2("1234.56")).toBe("1234.56");
    expect(money2("0.1")).toBe("0.10");
    expect(money2(0)).toBe("0.00");
    expect(money2("0")).toBe("0.00");
  });
  it("degrades a missing/garbage amount to 0.00, not NaN", () => {
    expect(money2(null)).toBe("0.00");
    expect(money2(undefined)).toBe("0.00");
    expect(money2("not-a-number")).toBe("0.00");
  });
  it("has no negative zero", () => {
    expect(money2(-0)).toBe("0.00");
  });
});

describe("toCanonicalRows — invoice rows", () => {
  it("maps net/vat/gross and uses the sent_at tax point", () => {
    const [row] = toCanonicalRows([inv({})], [], { todayIso: TODAY });
    expect(row).toEqual({
      date: "2026-07-01",
      type: "invoice",
      customer: "Acme Ltd",
      net: "100.00",
      vat: "20.00",
      gross: "120.00",
      invoice_number: "INV-0001",
      status: "sent",
    });
  });

  it("falls back to created_at when there is no sent_at", () => {
    const [row] = toCanonicalRows([inv({ sent_at: null })], [], {
      todayIso: TODAY,
    });
    expect(row?.date).toBe("2026-06-30");
  });

  it("computes gross from net+vat when total is absent", () => {
    const [row] = toCanonicalRows(
      [inv({ total: null, amount: "199.99", vat_total: "40.00" })],
      [],
      { todayIso: TODAY },
    );
    expect(row?.gross).toBe("239.99");
  });

  it("derives overdue status when past due and still owed", () => {
    const [row] = toCanonicalRows(
      [inv({ status: "sent", due_date: "2026-07-01" })],
      [],
      { todayIso: TODAY },
    );
    expect(row?.status).toBe("overdue");
  });

  it("never shows a paid invoice as overdue", () => {
    const [row] = toCanonicalRows(
      [inv({ status: "paid", due_date: "2020-01-01" })],
      [],
      { todayIso: TODAY },
    );
    expect(row?.status).toBe("paid");
  });

  it("blanks a missing customer name rather than emitting null", () => {
    const [row] = toCanonicalRows([inv({ customer_name: null })], [], {
      todayIso: TODAY,
    });
    expect(row?.customer).toBe("");
  });
});

describe("toCanonicalRows — payment rows", () => {
  it("maps a receipt: blank net/vat, gross = amount, status received", () => {
    const pay: CanonicalPaymentInput = {
      invoice_number: "INV-0007",
      customer_name: "Beta PLC",
      amount: "500.00",
      paid_at: "2026-07-15",
    };
    const [row] = toCanonicalRows([], [pay], { todayIso: TODAY });
    expect(row).toEqual({
      date: "2026-07-15",
      type: "payment",
      customer: "Beta PLC",
      net: "",
      vat: "",
      gross: "500.00",
      invoice_number: "INV-0007",
      status: "received",
    });
  });
});

describe("toCanonicalRows — deterministic ordering", () => {
  it("orders by date, then invoice number, then type (invoice before payment)", () => {
    const invoices = [
      inv({ number: "INV-0002", sent_at: "2026-07-02T00:00:00Z" }),
      inv({ number: "INV-0001", sent_at: "2026-07-01T00:00:00Z" }),
    ];
    const payments: CanonicalPaymentInput[] = [
      {
        invoice_number: "INV-0001",
        customer_name: "Acme Ltd",
        amount: 120,
        paid_at: "2026-07-01",
      },
    ];
    const rows = toCanonicalRows(invoices, payments, { todayIso: TODAY });
    expect(rows.map((r) => [r.date, r.type, r.invoice_number])).toEqual([
      ["2026-07-01", "invoice", "INV-0001"],
      ["2026-07-01", "payment", "INV-0001"],
      ["2026-07-02", "invoice", "INV-0002"],
    ]);
  });

  it("is a pure function of its inputs (two runs, identical output)", () => {
    const a = toCanonicalRows([inv({})], [], { todayIso: TODAY });
    const b = toCanonicalRows([inv({})], [], { todayIso: TODAY });
    expect(a).toEqual(b);
  });
});

describe("capRows — truncation is never silent", () => {
  it("does not flag truncation when the result is within the cap", () => {
    const { rows, truncated } = capRows([1, 2, 3], 5);
    expect(truncated).toBe(false);
    expect(rows).toEqual([1, 2, 3]);
  });

  it("does not flag truncation at exactly the cap", () => {
    const { rows, truncated } = capRows([1, 2, 3], 3);
    expect(truncated).toBe(false);
    expect(rows).toHaveLength(3);
  });

  it("flags truncation and slices to the cap when the probe row (cap+1) is present", () => {
    // Reads request cap+1, so a length past the cap is the truncation signal.
    const { rows, truncated } = capRows([1, 2, 3, 4], 3);
    expect(truncated).toBe(true);
    expect(rows).toEqual([1, 2, 3]);
  });

  it("returns a copy, never the input array", () => {
    const input = [1, 2, 3];
    const { rows } = capRows(input, 5);
    expect(rows).not.toBe(input);
    expect(rows).toEqual(input);
  });

  it("defaults the cap to MAX_ROWS", () => {
    expect(MAX_ROWS).toBe(50_000);
    const under = capRows(new Array(10).fill(0));
    expect(under.truncated).toBe(false);
  });
});

describe("toAccountingCsv — RFC-4180", () => {
  it("emits the fixed header in the documented column order", () => {
    const csv = toAccountingCsv([]);
    expect(csv).toBe("date,type,customer,net,vat,gross,invoice_number,status");
    expect(ACCOUNTING_CSV_COLUMNS.map((c) => c.header)).toEqual([
      "date",
      "type",
      "customer",
      "net",
      "vat",
      "gross",
      "invoice_number",
      "status",
    ]);
  });

  it("separates records with CRLF", () => {
    const rows = toCanonicalRows([inv({})], [], { todayIso: TODAY });
    const csv = toAccountingCsv(rows);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      "2026-07-01,invoice,Acme Ltd,100.00,20.00,120.00,INV-0001,sent",
    );
  });

  it("quotes commas, quotes and newlines; doubles embedded quotes", () => {
    const rows = toCanonicalRows(
      [
        inv({
          customer_name: 'O\'Brien, "Sons" & Co\nLtd',
          number: "INV-0009",
        }),
      ],
      [],
      { todayIso: TODAY },
    );
    const csv = toAccountingCsv(rows);
    const dataLine = csv.split("\r\n")[1];
    expect(dataLine).toContain('"O\'Brien, ""Sons"" & Co\nLtd"');
  });

  it("row count equals header + one line per canonical row", () => {
    const invoices = [inv({ number: "INV-0001" }), inv({ number: "INV-0002" })];
    const payments: CanonicalPaymentInput[] = [
      {
        invoice_number: "INV-0001",
        customer_name: "Acme",
        amount: 10,
        paid_at: "2026-07-05",
      },
    ];
    const rows = toCanonicalRows(invoices, payments, { todayIso: TODAY });
    const csv = toAccountingCsv(rows);
    expect(csv.split("\r\n")).toHaveLength(rows.length + 1);
    expect(rows).toHaveLength(3);
  });
});
