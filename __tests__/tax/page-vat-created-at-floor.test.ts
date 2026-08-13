import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  computeVatQuarter,
  computeCorpTaxYear,
  type InvoicePaymentRow,
} from "@/lib/tax/compute";

/**
 * Tax dashboard — output VAT must not drop invoices created before the tax-year
 * start (C-35 launch blocker), and the created_at floor cannot recur.
 *
 * THE ORIGINAL BUG. The tax page fetched invoices with a `.gte("created_at",
 * yearStartIso)` floor and fed that set into `computeVatQuarter`. Output VAT is
 * CASH: an invoice issued LATE in the previous tax year (created_at < yearStart)
 * but PAID this quarter was never fetched, so its output VAT vanished from the
 * tile while the PDF and the frozen HMRC 9-box return included it.
 *
 * THE FIX (now structural). Output VAT is PAYMENT-LEDGER-DRIVEN: it reads the
 * invoice_payments ledger windowed on `paid_at` (server/services/vat-quarter-inputs.ts),
 * resolving each payment's parent invoice by id. The parent's created_at NEVER
 * enters that read, so a pre-year invoice cannot be floored out of output VAT —
 * the class of bug is impossible, not merely fixed. Corporation Tax still reads
 * the invoices book (no created_at floor) and re-gates created_at internally.
 *
 * Hermetic — no Supabase client. The numeric contract of `computeVatQuarter` /
 * `computeCorpTaxYear` is exercised in __tests__/tax/compute.test.ts.
 */

type Invoice = {
  status: string;
  vat_total: number;
  total: number;
  amount: number;
  paid_at: string | null;
  created_at: string;
};

// Current VAT quarter Q3 (Jul–Sep 2025), well inside tax year 2025-04-06 … 2026-04-05.
const yearStart = "2025-04-06";
const quarterStart = "2025-07-01";
const quarterEnd = "2025-10-01"; // exclusive upper bound

// The whole org invoice book (what the tax page fetches for Corporation Tax).
const allInvoices: Invoice[] = [
  // A — issued LATE in the PREVIOUS tax year, PAID this quarter. The dropped row.
  { status: "paid", vat_total: 300, total: 1800, amount: 1500, paid_at: "2025-07-15", created_at: "2025-03-20" },
  // B — created and paid this quarter. Counts everywhere.
  { status: "paid", vat_total: 200, total: 1200, amount: 1000, paid_at: "2025-08-01", created_at: "2025-07-05" },
  // C — paid BEFORE the quarter. Excluded by paid_at in all readers.
  { status: "paid", vat_total: 999, total: 5994, amount: 4995, paid_at: "2025-06-15", created_at: "2025-05-01" },
];

// The invoice_payments ledger the fixed tax page builds: one full payment per
// paid invoice, windowed on paid_at. The parent invoice's created_at is NOT part
// of a ledger row — that is exactly why the floor can never drop a payment.
const ledger: InvoicePaymentRow[] = allInvoices
  .filter((i) => i.paid_at !== null)
  .map((i) => ({
    amount: i.total,
    paid_at: i.paid_at,
    invoice_vat_total: i.vat_total,
    invoice_amount: i.amount,
    invoice_total: i.total,
  }));

describe("tax page output VAT: invoice created before tax-year start but paid this quarter", () => {
  it("output VAT counts a payment whose PARENT invoice was created before the tax-year start", () => {
    // A (paid 2025-07-15, created 2025-03-20, pre-year) £300 + B £200; C excluded on paid_at.
    const vat = computeVatQuarter(ledger, [], quarterStart, quarterEnd);
    expect(vat.output_vat).toBe(500);
  });

  it("the ledger is windowed on paid_at, so a pre-year created_at cannot drop a payment", () => {
    // The class of bug is structurally impossible: a ledger row carries no
    // created_at to floor on. Removing A's payment removes exactly its £300.
    const withA = computeVatQuarter(ledger, [], quarterStart, quarterEnd);
    const withoutA = computeVatQuarter(
      ledger.filter((p) => p.paid_at !== "2025-07-15"),
      [],
      quarterStart,
      quarterEnd,
    );
    expect(withA.output_vat - withoutA.output_vat).toBe(300);
  });

  it("Corporation Tax is unaffected — computeCorpTaxYear re-gates created_at, so A never enters CT profit", () => {
    // The CT figure must be identical whether the page fetches all invoices (fixed)
    // or only created_at >= yearStart (old), because computeCorpTaxYear filters
    // created_at internally.
    const flooredRows = allInvoices.filter((i) => i.created_at >= yearStart);
    const ctFromFullFetch = computeCorpTaxYear(allInvoices, [], yearStart);
    const ctFromFlooredFetch = computeCorpTaxYear(flooredRows, [], yearStart);

    expect(ctFromFullFetch.estimated_profit).toBe(ctFromFlooredFetch.estimated_profit);
    expect(ctFromFullFetch.estimated_tax).toBe(ctFromFlooredFetch.estimated_tax);
    // A (created pre-year, £1,500 net) is excluded from CT revenue in BOTH; only
    // B (£1,000) and C (£4,995) count → £5,995 profit, unchanged by the VAT fix.
    expect(ctFromFullFetch.estimated_profit).toBe(5_995);
  });
});

describe("tax page source: created_at floor stays off the invoices read (guard)", () => {
  const code = readFileSync(resolve(process.cwd(), "app/(app)/tax/page.tsx"), "utf8");

  it("the invoices read no longer floors on created_at (the reintroduced-bug guard)", () => {
    // Isolate the invoices fetch block: from `.from("invoices")` to its `.range(`.
    const start = code.indexOf('.from("invoices")');
    expect(start).toBeGreaterThan(-1);
    const invoiceBlock = code.slice(start, code.indexOf(".range(", start));
    expect(invoiceBlock).not.toMatch(/\.gte\(\s*["']created_at["']/);
  });

  it("the finances read floors at the EARLIER of quarter/year start (financeFloorIso)", () => {
    // The finances read feeds BOTH computeCorpTaxYear (tax year) and
    // computeVatQuarter (this quarter). Because the calendar quarter starts 1
    // April while the tax year starts 6 April, flooring at yearStartIso silently
    // dropped 1–5 April finance rows that computeVatQuarter counts as in-quarter
    // — understating input VAT and disagreeing with the quarterly PDF + HMRC
    // 9-box return, both of which floor finances at the QUARTER start. The fix
    // fetches from `financeFloorIso = min(quarterStartIso, yearStartIso)`. This
    // guard fails if a mismatched (year-only) floor is reintroduced.
    const start = code.indexOf('.from("finances")');
    expect(start).toBeGreaterThan(-1);
    const financeBlock = code.slice(start, code.indexOf(".range(", start));
    expect(financeBlock).toMatch(/\.gte\(\s*["']created_at["']\s*,\s*financeFloorIso\s*\)/);
    // And must NOT re-narrow straight to yearStartIso.
    expect(financeBlock).not.toMatch(/\.gte\(\s*["']created_at["']\s*,\s*yearStartIso\s*\)/);
  });

  it("financeFloorIso is defined as the earlier of quarter/year start", () => {
    // The floor itself must be the MIN of the two starts, never hard-coded to
    // either — otherwise the Apr–Jun quarter re-breaks or a mid-year quarter
    // over-fetches an extra tax year.
    expect(code).toMatch(
      /const\s+financeFloorIso\s*=\s*quarterStartIso\s*<\s*yearStartIso\s*\?\s*quarterStartIso\s*:\s*yearStartIso/,
    );
  });
});
