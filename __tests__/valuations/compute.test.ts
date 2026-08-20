import { describe, it, expect } from "vitest";
import {
  computeValuationFigures,
  resolveValuationFigures,
  sumCertifiedBase,
  type CumulationValuation,
} from "@/lib/valuations/compute";
import { buildPortalValuationView, VALUATION_PORTAL_KEYS } from "@/lib/valuations/portal";
import { computeRetentionPosition } from "@/lib/retentions/compute";

/**
 * Construction valuation / application-for-payment — money-model proofs.
 *
 * The load-bearing invariants (mirrors migration 20261192000000):
 *   1. previous-vs-current CUMULATION: each period bills exactly the increment.
 *   2. retention applied ONCE: the invoice amount is the FULL certified increment,
 *      never net of retention; retention is derived once by the retention
 *      authority and the per-period display splits reconcile to it.
 *   3. variation INCLUSION: agreed variations lift the gross (and thus the amount).
 *   4. portal projection carries NO internal cost.
 */

describe("valuation cumulation (previous vs current)", () => {
  it("bills only the increment each period; increments telescope to latest gross", () => {
    // Val 1 — cumulative gross works £100,000, nothing certified before.
    const v1 = computeValuationFigures({
      workCompletedToDate: 100_000,
      materialsOnSite: 0,
      variationsTotal: 0,
      deductions: 0,
      previousCertifiedGross: 0,
      retentionPercent: 5,
      vatRate: 20,
    });
    expect(v1.gross).toBe(100_000);
    expect(v1.netCertifiedThis).toBe(100_000);

    // Val 2 — cumulative gross now £150,000; £100,000 already certified.
    const v2 = computeValuationFigures({
      workCompletedToDate: 150_000,
      materialsOnSite: 0,
      variationsTotal: 0,
      deductions: 0,
      previousCertifiedGross: v1.netCertifiedThis,
      retentionPercent: 5,
      vatRate: 20,
    });
    // Bills the DELTA, not the whole cumulative value.
    expect(v2.netCertifiedThis).toBe(50_000);

    // Σ increments === latest cumulative gross (nothing billed twice).
    expect(v1.netCertifiedThis + v2.netCertifiedThis).toBe(150_000);
  });

  it("deductions reduce only that period's certified increment", () => {
    const v = computeValuationFigures({
      workCompletedToDate: 80_000,
      materialsOnSite: 0,
      variationsTotal: 0,
      deductions: 5_000,
      previousCertifiedGross: 60_000,
      retentionPercent: 3,
      vatRate: 20,
    });
    // 80,000 − 60,000 − 5,000
    expect(v.netCertifiedThis).toBe(15_000);
  });

  it("flags (and never bills) a negative increment", () => {
    const v = computeValuationFigures({
      workCompletedToDate: 40_000,
      materialsOnSite: 0,
      variationsTotal: 0,
      deductions: 0,
      previousCertifiedGross: 60_000,
      retentionPercent: 5,
      vatRate: 20,
    });
    expect(v.wouldGoNegative).toBe(true);
    expect(v.netCertifiedThis).toBe(0);
  });

  it("sumCertifiedBase counts only certified/invoiced siblings, excluding self", () => {
    const rows: CumulationValuation[] = [
      { id: "a", status: "invoiced", net_certified_this: 100_000 },
      { id: "b", status: "certified", net_certified_this: 50_000 },
      { id: "c", status: "submitted", net_certified_this: 30_000 }, // not yet certified
      { id: "d", status: "draft", net_certified_this: 10_000 },
    ];
    // For a new draft, base = a + b only.
    expect(sumCertifiedBase(rows)).toBe(150_000);
    // Excluding 'a' (itself): b only.
    expect(sumCertifiedBase(rows, "a")).toBe(50_000);
  });
});

describe("retention applied exactly once (no double count)", () => {
  it("the invoice amount is the FULL increment — retention is NOT subtracted from it", () => {
    const v = computeValuationFigures({
      workCompletedToDate: 100_000,
      materialsOnSite: 0,
      variationsTotal: 0,
      deductions: 0,
      previousCertifiedGross: 0,
      retentionPercent: 5,
      vatRate: 20,
    });
    // The stage invoice amount = net_certified_this = 100,000 (gross increment),
    // NOT 95,000. If it were 95,000 the retention authority would then accrue on
    // the reduced figure — that is the double count this asserts against.
    expect(v.netCertifiedThis).toBe(100_000);
    expect(v.retentionThis).toBe(5_000); // display split only
    expect(v.netPayableThis).toBe(95_000); // cash certified this period (display)
  });

  it("per-period retention splits reconcile to the retention authority's accrual", () => {
    const rate = 5;
    const v1 = computeValuationFigures({
      workCompletedToDate: 100_000, materialsOnSite: 0, variationsTotal: 0,
      deductions: 0, previousCertifiedGross: 0, retentionPercent: rate, vatRate: 20,
    });
    const v2 = computeValuationFigures({
      workCompletedToDate: 150_000, materialsOnSite: 0, variationsTotal: 0,
      deductions: 0, previousCertifiedGross: v1.netCertifiedThis, retentionPercent: rate, vatRate: 20,
    });

    // The generated stage invoices carry the FULL increments as ex-VAT amount.
    const invoices = [
      { status: "sent", amount: v1.netCertifiedThis },
      { status: "sent", amount: v2.netCertifiedThis },
    ];
    const position = computeRetentionPosition({ ratePercent: rate, invoices, releases: [] });

    // Retention exists in exactly ONE place — derived by the authority from the
    // invoices — and the per-valuation display splits sum to it. No second ledger.
    expect(position.accrued).toBe(7_500); // 5% × 150,000
    expect(v1.retentionThis + v2.retentionThis).toBe(position.accrued);
  });

  it("a draft variation accept-invoice (status draft) never accrues retention", () => {
    // Only the certified stage invoice (sent) counts; a lingering draft does not.
    const position = computeRetentionPosition({
      ratePercent: 5,
      invoices: [
        { status: "sent", amount: 100_000 },
        { status: "draft", amount: 20_000 }, // a variation's draft accept-invoice
      ],
      releases: [],
    });
    expect(position.accrued).toBe(5_000); // 5% × 100,000, the draft excluded
  });
});

describe("variation inclusion", () => {
  it("agreed variations lift the gross valuation and the certified increment", () => {
    const withoutVar = computeValuationFigures({
      workCompletedToDate: 100_000, materialsOnSite: 5_000, variationsTotal: 0,
      deductions: 0, previousCertifiedGross: 0, retentionPercent: 5, vatRate: 20,
    });
    const withVar = computeValuationFigures({
      workCompletedToDate: 100_000, materialsOnSite: 5_000, variationsTotal: 20_000,
      deductions: 0, previousCertifiedGross: 0, retentionPercent: 5, vatRate: 20,
    });
    expect(withoutVar.gross).toBe(105_000);
    expect(withVar.gross).toBe(125_000);
    expect(withVar.netCertifiedThis - withoutVar.netCertifiedThis).toBe(20_000);
  });
});

describe("resolveValuationFigures uses frozen snapshot for certified rows", () => {
  it("returns the snapshot columns verbatim once certified", () => {
    const figures = resolveValuationFigures(
      {
        id: "x",
        status: "certified",
        work_completed_to_date: 999, // ignored — snapshot wins
        materials_on_site: 999,
        deductions: 0,
        vat_rate: 20,
        variations_total: 10_000,
        gross_valuation: 120_000,
        previous_certified_gross: 100_000,
        net_certified_this: 20_000,
        retention_percent: 5,
      },
      [],
      0,
      0,
    );
    expect(figures.gross).toBe(120_000);
    expect(figures.netCertifiedThis).toBe(20_000);
    expect(figures.retentionThis).toBe(1_000); // 5% × 20,000
  });
});

describe("portal projection is cost-free and nets retention", () => {
  it("amount_due nets retention off the increment and adds VAT", () => {
    const view = buildPortalValuationView({
      id: "v1",
      sequence: 1,
      status: "certified",
      periodStart: null,
      periodEnd: "2026-08-31",
      valuationDate: "2026-08-31",
      workCompletedToDate: 100_000,
      materialsOnSite: 0,
      variationsTotal: 0,
      deductions: 0,
      previousCertifiedGross: 0,
      retentionPercent: 5,
      vatRate: 20,
      invoiceNumber: "INV-0007",
    });
    // increment 100,000 − retention 5,000 = 95,000 net + VAT (20% of 100,000 = 20,000)
    expect(view.net_certified_this).toBe(100_000);
    expect(view.retention_this).toBe(5_000);
    expect(view.amount_due).toBe(115_000); // 95,000 + 20,000
  });

  it("exposes only the enumerated customer-safe keys and no cost field", () => {
    const view = buildPortalValuationView({
      id: "v1", sequence: 1, status: "submitted", periodStart: null, periodEnd: null,
      valuationDate: "2026-08-31", workCompletedToDate: 100_000, materialsOnSite: 0,
      variationsTotal: 20_000, deductions: 0, previousCertifiedGross: 0,
      retentionPercent: 5, vatRate: 20, invoiceNumber: null,
    });
    expect(Object.keys(view).sort()).toEqual([...VALUATION_PORTAL_KEYS].sort());
    const json = JSON.stringify(view);
    expect(json.toLowerCase()).not.toContain("cost");
    expect(json).not.toContain("margin");
    expect(json).not.toContain("labour");
  });
});
