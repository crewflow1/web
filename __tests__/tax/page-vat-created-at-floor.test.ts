import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeVatQuarter, computeCorpTaxYear } from "@/lib/tax/compute";

/**
 * Tax dashboard — output VAT must not drop invoices created before the tax-year
 * start (C-35 launch blocker).
 *
 * THE BUG. The tax page fetched invoices with a `.gte("created_at", yearStartIso)`
 * floor and fed that set into `computeVatQuarter`. Output VAT is CASH — it counts
 * every invoice PAID (`paid_at`) inside the quarter, regardless of when it was
 * created. So an invoice issued LATE in the previous tax year (created_at <
 * yearStart) but PAID early in the current VAT quarter was never fetched, and its
 * output VAT silently vanished from the on-screen tile — while the quarterly PDF
 * (`app/api/tax/quarterly-pdf/route.ts`) and the frozen HMRC 9-box return
 * (`server/services/hmrc-connections.ts`) both read paid invoices on `paid_at`
 * with NO created_at floor and DID include it. The tile therefore under-reported
 * and contradicted the authoritative figures.
 *
 * THE FIX. The tax page's invoices read drops the created_at floor and fetches all
 * org invoices (still paged, org-pinned, id tiebreak). Safe for Corporation Tax:
 * `computeCorpTaxYear` re-gates revenue/costs on created_at itself, so a pre-year
 * invoice never enters the CT profit even though it is now fetched.
 *
 * These assertions model the three read predicates over ONE shared dataset and
 * prove they now agree; the numeric contract of `computeVatQuarter` /
 * `computeCorpTaxYear` is exercised in __tests__/tax/compute.test.ts. Hermetic —
 * no Supabase client.
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

// The whole org invoice book (what the FIXED tax page fetches — no created_at floor).
const allInvoices: Invoice[] = [
  // A — issued LATE in the PREVIOUS tax year, PAID this quarter. The dropped row.
  { status: "paid", vat_total: 300, total: 1800, amount: 1500, paid_at: "2025-07-15", created_at: "2025-03-20" },
  // B — created and paid this quarter. Counts everywhere.
  { status: "paid", vat_total: 200, total: 1200, amount: 1000, paid_at: "2025-08-01", created_at: "2025-07-05" },
  // C — paid BEFORE the quarter. Excluded by paid_at in all three readers.
  { status: "paid", vat_total: 999, total: 5994, amount: 4995, paid_at: "2025-06-15", created_at: "2025-05-01" },
];

// The authoritative readers select paid invoices by paid_at only, no created_at floor.
const paidInQuarter = (inv: Invoice): boolean =>
  inv.status === "paid" &&
  inv.paid_at !== null &&
  inv.paid_at >= quarterStart &&
  inv.paid_at < quarterEnd;

describe("tax page output VAT: invoice created before tax-year start but paid this quarter", () => {
  it("the FIXED tax-page read (no created_at floor) matches the quarterly-PDF / HMRC output VAT", () => {
    // Fixed tax page: fetch ALL invoices, then computeVatQuarter re-windows on paid_at.
    const tilePageVat = computeVatQuarter(allInvoices, [], quarterStart, quarterEnd);
    // Quarterly PDF + HMRC composer: DB already filters to paid-in-quarter, same authority.
    const pdfRows = allInvoices.filter(paidInQuarter);
    const pdfVat = computeVatQuarter(pdfRows, [], quarterStart, quarterEnd);
    const hmrcVat = computeVatQuarter(pdfRows, [], quarterStart, quarterEnd);

    // A (300) + B (200); C excluded on paid_at.
    expect(tilePageVat.output_vat).toBe(500);
    expect(tilePageVat.output_vat).toBe(pdfVat.output_vat);
    expect(tilePageVat.output_vat).toBe(hmrcVat.output_vat);
  });

  it("the pre-fix created_at floor DROPPED invoice A — reproducing the understatement", () => {
    // Pre-fix predicate: WHERE created_at >= yearStart. A (created 2025-03-20) is lost.
    const flooredRows = allInvoices.filter((i) => i.created_at >= yearStart);
    const buggyVat = computeVatQuarter(flooredRows, [], quarterStart, quarterEnd);

    expect(buggyVat.output_vat).toBe(200); // only B; A's £300 silently missing
    // The fix recovers exactly A's £300 of output VAT.
    const fixedVat = computeVatQuarter(allInvoices, [], quarterStart, quarterEnd);
    expect(fixedVat.output_vat - buggyVat.output_vat).toBe(300);
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
