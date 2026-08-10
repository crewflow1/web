import { describe, it, expect } from "vitest";
import {
  computeVatQuarter,
  computeCorpTaxYear,
  endOfQuarterExclusiveIso,
} from "@/lib/tax/compute";
import {
  computeOrgCashOut,
  type CashOutVatInvoiceRow,
} from "@/lib/commercial/cash-out";

/**
 * VAT input-floor consistency across the THREE authoritative surfaces
 * (launch blocker — Apr–Jun quarter).
 *
 * ── THE BUG ──────────────────────────────────────────────────────────────────
 * The UK calendar VAT quarter starts 1 April; the UK tax year starts 6 April.
 * The /tax page (app/(app)/tax/page.tsx) fetched finances with a
 * `.gte("created_at", yearStartIso)` (6 April) floor but fed that same array into
 * computeVatQuarter with quarterStartIso (1 April) as the lower bound. Finance
 * rows dated 1–5 April are IN-QUARTER for VAT but were never fetched — so the
 * on-screen tile UNDER-stated input VAT and OVER-stated net VAT payable.
 *
 * The two authoritative artifacts both floor finances at the QUARTER start:
 *   • app/api/tax/quarterly-pdf/route.ts   → .gte('created_at', qStart)         (1 Apr)
 *   • server/services/hmrc-connections.ts  → .gte('created_at', quarterStartIso)(1 Apr)
 * so the tile disagreed with the downloadable PDF and the prepared/held 9-box
 * return. The fix floors the page's finances read at
 * `financeFloorIso = min(quarterStartIso, yearStartIso)` = 1 April.
 *
 * ── WHAT THIS TEST PINS ──────────────────────────────────────────────────────
 * Over ONE shared finance dataset that includes a 1–5 April cost, it models each
 * surface's finance-fetch floor and asserts all three now consume the SAME window
 * and therefore the SAME input VAT. It FAILS if any surface re-introduces a
 * mismatched floor. Hermetic — no Supabase client. The numeric contract of
 * computeVatQuarter lives in __tests__/tax/compute.test.ts.
 */

type FinanceRow = { vat_total: number; amount: number; created_at: string };

// Apr–Jun quarter of tax year 2025/26. Quarter starts 1 Apr; tax year 6 Apr.
const quarterStartIso = "2025-04-01";
const quarterEndIso = "2025-07-01"; // exclusive
const yearStartIso = "2025-04-06";

// The page's fix: fetch finances from the EARLIER of the two starts.
const financeFloorIso =
  quarterStartIso < yearStartIso ? quarterStartIso : yearStartIso;

// The whole org finance book (what the DB holds, before any read floor).
const allFinances: FinanceRow[] = [
  // X — dated 3 April: IN the VAT quarter (>= 1 Apr) but BEFORE the tax year
  // start (< 6 Apr). This is the row the buggy year-floor silently dropped.
  { vat_total: 40, amount: 200, created_at: "2025-04-03" },
  // Y — dated 20 May: unambiguously in-quarter under every floor.
  { vat_total: 60, amount: 300, created_at: "2025-05-20" },
  // Z — dated 15 March (previous tax year): out of the quarter under every floor.
  { vat_total: 999, amount: 5000, created_at: "2025-03-15" },
];

/** Model a DB read: rows on/after the given floor. */
const flooredAt = (iso: string): FinanceRow[] =>
  allFinances.filter((f) => f.created_at >= iso);

describe("VAT input floor is identical across tile / PDF / HMRC 9-box (Apr–Jun)", () => {
  it("the page's financeFloorIso equals the quarter start the PDF & HMRC use", () => {
    // All three surfaces floor finances at the QUARTER start for this quarter.
    expect(financeFloorIso).toBe(quarterStartIso);
    expect(financeFloorIso).toBe("2025-04-01");
  });

  it("all three surfaces compute the SAME input VAT, and it includes the 1–5 April cost", () => {
    // /tax page (fixed): fetch finances >= financeFloorIso, window in computeVatQuarter.
    const tile = computeVatQuarter(
      [],
      flooredAt(financeFloorIso),
      quarterStartIso,
      quarterEndIso,
    );
    // Quarterly PDF: DB floors finances at qStart (1 Apr).
    const pdf = computeVatQuarter(
      [],
      flooredAt(quarterStartIso),
      quarterStartIso,
      quarterEndIso,
    );
    // HMRC 9-box composer: DB floors finances at quarterStartIso (1 Apr).
    const hmrc = computeVatQuarter(
      [],
      flooredAt(quarterStartIso),
      quarterStartIso,
      quarterEndIso,
    );

    // X (40) + Y (60); Z excluded. The 3 April cost is present in all three.
    expect(tile.input_vat).toBe(100);
    expect(tile.input_vat).toBe(pdf.input_vat);
    expect(tile.input_vat).toBe(hmrc.input_vat);
    // Net VAT payable (0 output − 100 input) agrees across all three.
    expect(tile.net_payable).toBe(pdf.net_payable);
    expect(tile.net_payable).toBe(hmrc.net_payable);
  });

  it("the pre-fix year-floor (6 April) DROPPED the 1–5 April cost — the understatement", () => {
    // Buggy page: fetch finances >= yearStartIso (6 Apr), still window at 1 Apr.
    const buggy = computeVatQuarter(
      [],
      flooredAt(yearStartIso),
      quarterStartIso,
      quarterEndIso,
    );
    const fixed = computeVatQuarter(
      [],
      flooredAt(financeFloorIso),
      quarterStartIso,
      quarterEndIso,
    );
    expect(buggy.input_vat).toBe(60); // only Y; X's £40 silently missing
    // Understated input VAT ⇒ OVERSTATED net payable by exactly X's £40.
    expect(buggy.net_payable - fixed.net_payable).toBe(40);
    // The fix recovers exactly the dropped 1–5 April input VAT.
    expect(fixed.input_vat - buggy.input_vat).toBe(40);
  });

  it("/cash uses the SAME bounded quarter window — a future-dated paid invoice cannot leak a later quarter's VAT", () => {
    // ── THE /cash DIVERGENCE ────────────────────────────────────────────────
    // /cash folds computeVatQuarter().net_payable into outflowDueNow. `paid_at`
    // is user-controllable, so a PAID invoice can be post-dated into a LATER
    // quarter (a post-dated cheque). The tile/PDF/HMRC surfaces all pass the
    // EXCLUSIVE upper bound, so they exclude it; if cash-out omits the bound its
    // inPeriod() degrades to `iso >= quarterStart` with NO ceiling and the later
    // quarter's output VAT leaks into /cash's current "VAT due".
    const quarterEndExclusive = endOfQuarterExclusiveIso(quarterStartIso); // 2025-07-01

    const vatInvoices: CashOutVatInvoiceRow[] = [
      // In-quarter paid invoice: 100 of output VAT. Counts under every window.
      {
        status: "paid",
        vat_total: 100,
        total: 600,
        amount: 500,
        paid_at: "2025-05-10",
        created_at: "2025-05-10",
      },
      // Post-dated cheque: PAID but paid_at is in the NEXT quarter (15 Aug).
      // The bounded window (< 1 Jul) MUST exclude its 500 of output VAT.
      {
        status: "paid",
        vat_total: 500,
        total: 3000,
        amount: 2500,
        paid_at: "2025-08-15",
        created_at: "2025-08-15",
      },
    ];

    // The /tax authority on the bounded window: only the in-quarter 100 counts.
    const authority = computeVatQuarter(
      vatInvoices,
      [],
      quarterStartIso,
      quarterEndExclusive,
    );
    expect(authority.net_payable).toBe(100);

    // The pre-fix open-ended window (what a 3-arg cash-out call degrades to)
    // would leak the post-dated 500 in — this is the divergence being pinned out.
    const openEnded = computeVatQuarter(vatInvoices, [], quarterStartIso);
    expect(openEnded.net_payable).toBe(600);

    // /cash via the REAL code path: everything else empty, VAT only.
    const cash = computeOrgCashOut({
      bills: [],
      payments: [],
      allocations: [],
      purchaseOrders: [],
      payrollRuns: [],
      payrollLines: [],
      cisSnapshots: [],
      vatInvoices,
      vatFinances: [],
      quarterStartIso,
      todayIso: "2025-05-15",
    });

    // /cash's VAT window is IDENTICAL to the /tax authority: the post-dated
    // 500 is excluded. Fails (cash.vatDue === 600) if cash-out drops the bound.
    expect(cash.vatDue).toBe(authority.net_payable);
    expect(cash.vatDue).toBe(100);
    expect(cash.vatDue).not.toBe(openEnded.net_payable); // the leaked 600
  });

  it("Corporation Tax is unchanged by the wider fetch — computeCorpTaxYear re-gates on yearStart", () => {
    // Widening the finances fetch to 1 April must NOT change CT: computeCorpTaxYear
    // filters costs on created_at >= yearStartIso itself, so the 3 April row (X)
    // never enters CT costs whether or not it is fetched.
    const ctWide = computeCorpTaxYear([], flooredAt(financeFloorIso), yearStartIso);
    const ctNarrow = computeCorpTaxYear([], flooredAt(yearStartIso), yearStartIso);
    expect(ctWide.estimated_profit).toBe(ctNarrow.estimated_profit);
    expect(ctWide.estimated_tax).toBe(ctNarrow.estimated_tax);
    // X (£200, dated 3 Apr) and Z (pre-year) both excluded from CT costs; only Y
    // (£300) counts. No revenue ⇒ profit floored at 0 in both.
    expect(ctWide.estimated_profit).toBe(0);
  });
});
