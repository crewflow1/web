import { describe, it, expect } from "vitest";
import {
  computeVatQuarter,
  computeVatNetTotals,
  normalizeVatScheme,
  limitedCostTraderTest,
  resolveFlatRatePercent,
  resolveFlatRateForPeriod,
  flatRateTurnoverInclVat,
  relevantGoodsInclVat,
  DEFAULT_VAT_SCHEME,
  DEFAULT_FLAT_RATE_CONFIG,
  FRS_LIMITED_COST_PERCENT,
  type InvoicePaymentRow,
  type AccrualInvoiceRow,
  type FlatRateSchemeConfig,
  type VatComputeOptions,
} from "@/lib/tax/compute";

// The Q1 return window used throughout: [2026-04-01, 2026-07-01).
const Q_START = "2026-04-01";
const Q_END = "2026-07-01";

/** A full payment of an invoice (gross cash), for the cash-basis ledger. */
function payment(
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

function invoice(
  taxPoint: string | null,
  status: string,
  v: { vat_total: number; amount: number; total: number },
): AccrualInvoiceRow {
  return {
    status,
    tax_point: taxPoint,
    vat_total: v.vat_total,
    amount: v.amount,
    total: v.total,
  };
}

describe("VAT scheme — default and normalisation", () => {
  it("defaults to cash and normalises unknown values to cash", () => {
    expect(DEFAULT_VAT_SCHEME).toBe("cash");
    expect(normalizeVatScheme(undefined)).toBe("cash");
    expect(normalizeVatScheme("garbage")).toBe("cash");
    expect(normalizeVatScheme("standard")).toBe("standard");
    expect(normalizeVatScheme("cash")).toBe("cash");
  });

  it("computeVatQuarter with NO opts is byte-for-byte the cash-basis behaviour", () => {
    const inv = { vat_total: 200, amount: 1000, total: 1200 };
    const payments = [payment("2026-05-10", inv)];
    const finances = [{ vat_total: 50, amount: 250, created_at: "2026-05-01" }];

    const bare = computeVatQuarter(payments, finances, Q_START, Q_END, 0);
    const explicitCash = computeVatQuarter(payments, finances, Q_START, Q_END, 0, {
      scheme: "cash",
    });
    expect(bare).toEqual(explicitCash);
    expect(bare.output_vat).toBe(200);
    expect(bare.input_vat).toBe(50);
    expect(bare.net_payable).toBe(150);
  });
});

describe("VAT scheme — cash vs standard divergence on a straddling invoice", () => {
  // Invoice issued 2026-04-15 (tax point in Q1) but PAID 2026-07-10 (Q2).
  const inv = { vat_total: 200, amount: 1000, total: 1200 };
  const straddlingPayment = payment("2026-07-10", inv);
  const straddlingInvoice = invoice("2026-04-15", "sent", inv);
  const finances = [{ vat_total: 0, amount: 0, created_at: "2026-05-01" }];

  it("CASH counts output VAT in the quarter the cash lands (Q1 = 0)", () => {
    const cash = computeVatQuarter([straddlingPayment], finances, Q_START, Q_END, 0, {
      scheme: "cash",
    });
    expect(cash.output_vat).toBe(0); // paid in Q2, so nothing in Q1
  });

  it("STANDARD counts output VAT at the invoice tax point (Q1 = 200)", () => {
    const std = computeVatQuarter([straddlingPayment], finances, Q_START, Q_END, 0, {
      scheme: "standard",
      accrualInvoices: [straddlingInvoice],
    });
    expect(std.output_vat).toBe(200); // tax point 2026-04-15 is in Q1
  });

  it("STANDARD ignores draft invoices (a draft is not a tax point)", () => {
    const draft = invoice("2026-04-15", "draft", inv);
    const std = computeVatQuarter([], finances, Q_START, Q_END, 0, {
      scheme: "standard",
      accrualInvoices: [draft],
    });
    expect(std.output_vat).toBe(0);
  });

  it("STANDARD net totals: box 6 = issued net, box 7 = logged purchases", () => {
    const purchases = [
      { vat_total: 20, amount: 100, created_at: "2026-05-02" },
      { vat_total: 0, amount: 0, created_at: "2026-01-01" }, // out of window
    ];
    const totals = computeVatNetTotals([], purchases, Q_START, Q_END, {
      scheme: "standard",
      accrualInvoices: [straddlingInvoice],
    });
    expect(totals.totalValueSalesExVAT).toBe(1000); // net of the issued invoice
    expect(totalOfPurchases(totals)).toBe(100);
  });
});

function totalOfPurchases(t: { totalValuePurchasesExVAT: number }): number {
  return t.totalValuePurchasesExVAT;
}

describe("VAT scheme — standard degrades safely with no accrual rows", () => {
  it("returns 0 output VAT rather than throwing when accrualInvoices is omitted", () => {
    const std = computeVatQuarter([], [], Q_START, Q_END, 0, { scheme: "standard" });
    expect(std.output_vat).toBe(0);
    expect(std.net_payable).toBe(0);
  });
});

describe("Flat Rate Scheme — flat calculation replaces line-by-line output VAT", () => {
  const inv = { vat_total: 200, amount: 1000, total: 1200 };
  const payments = [payment("2026-05-10", inv)]; // gross cash received 1200
  const finances = [{ vat_total: 50, amount: 250, created_at: "2026-05-01" }];

  it("box 1 = flat % of gross turnover; input VAT is NOT reclaimed (box 4 = 0)", () => {
    const opts: VatComputeOptions = {
      scheme: "cash",
      flatRate: { applies: true, effectivePercent: 10 },
    };
    const vat = computeVatQuarter(payments, finances, Q_START, Q_END, 0, opts);
    expect(vat.output_vat).toBe(120); // 10% of 1200 gross
    expect(vat.input_vat).toBe(0); // FRS: no input reclaim
    expect(vat.net_payable).toBe(120);
  });

  it("box 6 = gross (VAT-inclusive) flat-rate turnover; box 7 = 0", () => {
    const totals = computeVatNetTotals(payments, finances, Q_START, Q_END, {
      scheme: "cash",
      flatRate: { applies: true, effectivePercent: 10 },
    });
    expect(totals.totalValueSalesExVAT).toBe(1200); // GROSS under FRS
    expect(totals.totalValuePurchasesExVAT).toBe(0);
  });

  it("does NOT engage when flatRate.applies is false — standard output VAT stands", () => {
    const vat = computeVatQuarter(payments, finances, Q_START, Q_END, 0, {
      scheme: "cash",
      flatRate: { applies: false, effectivePercent: 10 },
    });
    expect(vat.output_vat).toBe(200);
    expect(vat.input_vat).toBe(50);
  });

  it("reverse charge stays net-neutral under FRS (added to boxes 1 AND 4)", () => {
    const vat = computeVatQuarter(payments, finances, Q_START, Q_END, 300, {
      scheme: "cash",
      flatRate: { applies: true, effectivePercent: 10 },
    });
    // 10% of 1200 = 120 flat + 300 RC output; 0 input + 300 RC input.
    expect(vat.output_vat).toBe(420);
    expect(vat.input_vat).toBe(300);
    expect(vat.net_payable).toBe(120); // RC nets out
  });

  it("FRS turnover is gross under standard basis too (accrual)", () => {
    const opts: VatComputeOptions = {
      scheme: "standard",
      accrualInvoices: [invoice("2026-04-15", "sent", inv)],
      flatRate: { applies: true, effectivePercent: 10 },
    };
    const vat = computeVatQuarter([], finances, Q_START, Q_END, 0, opts);
    expect(vat.output_vat).toBe(120); // 10% of the 1200 gross invoice total
  });
});

describe("FRS rate resolution — sector %, first-year discount, limited-cost flip", () => {
  it("plain sector rate", () => {
    expect(
      resolveFlatRatePercent({ sectorPercent: 9.5, limitedCostTrader: false, firstYearDiscount: false }),
    ).toBe(9.5);
  });

  it("first-year discount takes 1 point off the sector rate", () => {
    expect(
      resolveFlatRatePercent({ sectorPercent: 9.5, limitedCostTrader: false, firstYearDiscount: true }),
    ).toBe(8.5);
  });

  it("limited-cost trader forces 16.5%, ignoring the sector rate", () => {
    expect(
      resolveFlatRatePercent({ sectorPercent: 9.5, limitedCostTrader: true, firstYearDiscount: false }),
    ).toBe(FRS_LIMITED_COST_PERCENT);
    expect(FRS_LIMITED_COST_PERCENT).toBe(16.5);
  });

  it("first-year discount applies on TOP of the 16.5% limited-cost rate → 15.5%", () => {
    expect(
      resolveFlatRatePercent({ sectorPercent: 9.5, limitedCostTrader: true, firstYearDiscount: true }),
    ).toBe(15.5);
  });

  it("never returns a negative percentage", () => {
    expect(
      resolveFlatRatePercent({ sectorPercent: 0.5, limitedCostTrader: false, firstYearDiscount: true }),
    ).toBe(0);
  });
});

describe("Limited-cost-trader test (HMRC VAT Notice 733 §4.4)", () => {
  it("limited when goods are below 2% of turnover", () => {
    expect(limitedCostTraderTest(100, 10_000, 3)).toBe(true); // 2%=200, floor=250, max 250; 100<250
  });

  it("NOT limited when goods clear both 2% and the £250 quarter floor", () => {
    expect(limitedCostTraderTest(300, 10_000, 3)).toBe(false); // max(200,250)=250; 300>=250
  });

  it("limited when the 2% threshold exceeds the £250 floor and goods fall below it", () => {
    expect(limitedCostTraderTest(300, 20_000, 3)).toBe(true); // 2%=400 > 250; 300<400
  });

  it("boundary: goods exactly at the £250 floor is NOT limited (strict <)", () => {
    expect(limitedCostTraderTest(250, 10_000, 3)).toBe(false);
  });

  it("scales the £250 floor to a MONTHLY period (~£83.33)", () => {
    expect(limitedCostTraderTest(50, 1_000, 1)).toBe(true); // floor 83.33; 50<83.33
    expect(limitedCostTraderTest(100, 1_000, 1)).toBe(false); // 100>=83.33 and >=2% (20)
  });
});

describe("resolveFlatRateForPeriod — gating, first-year window, LCT override", () => {
  const base: FlatRateSchemeConfig = {
    ...DEFAULT_FLAT_RATE_CONFIG,
    enabled: true,
    sector_percent: 9.5,
  };

  it("disabled config never applies", () => {
    const r = resolveFlatRateForPeriod(DEFAULT_FLAT_RATE_CONFIG, Q_START, Q_END, 10_000, 100);
    expect(r.applies).toBe(false);
    expect(r.effectivePercent).toBe(0);
  });

  it("applies within the effective window", () => {
    const cfg = { ...base, effective_from: "2026-04-01", effective_to: "2026-07-01" };
    const r = resolveFlatRateForPeriod(cfg, Q_START, Q_END, 10_000, 5_000);
    expect(r.applies).toBe(true);
    expect(r.effectivePercent).toBe(9.5); // goods 5000 clear 2% (200) & floor → not LCT
    expect(r.limitedCostTrader).toBe(false);
  });

  it("does NOT apply before effective_from", () => {
    const cfg = { ...base, effective_from: "2026-07-01" };
    expect(resolveFlatRateForPeriod(cfg, Q_START, Q_END, 10_000, 5_000).applies).toBe(false);
  });

  it("does NOT apply once the period starts on/after effective_to", () => {
    const cfg = { ...base, effective_to: "2026-04-01" };
    expect(resolveFlatRateForPeriod(cfg, Q_START, Q_END, 10_000, 5_000).applies).toBe(false);
  });

  it("applies the first-year discount inside the registration-anniversary window", () => {
    const cfg = {
      ...base,
      registration_date: "2026-01-01",
      first_year_discount: true,
    };
    const inYear = resolveFlatRateForPeriod(cfg, "2026-12-01", "2027-03-01", 10_000, 5_000);
    expect(inYear.firstYearApplied).toBe(true);
    expect(inYear.effectivePercent).toBe(8.5);

    const afterYear = resolveFlatRateForPeriod(cfg, "2027-01-01", "2027-04-01", 10_000, 5_000);
    expect(afterYear.firstYearApplied).toBe(false); // anniversary reached
    expect(afterYear.effectivePercent).toBe(9.5);
  });

  it("auto LCT flips to 16.5% when goods are too low", () => {
    const cfg = { ...base, limited_cost: "auto" as const };
    const r = resolveFlatRateForPeriod(cfg, Q_START, Q_END, 10_000, 50);
    expect(r.limitedCostTrader).toBe(true);
    expect(r.effectivePercent).toBe(16.5);
  });

  it("limited_cost override forces the flag regardless of goods", () => {
    const forced = { ...base, limited_cost: "yes" as const };
    expect(resolveFlatRateForPeriod(forced, Q_START, Q_END, 10_000, 9_000).limitedCostTrader).toBe(true);
    const never = { ...base, limited_cost: "no" as const };
    expect(resolveFlatRateForPeriod(never, Q_START, Q_END, 10_000, 1).limitedCostTrader).toBe(false);
  });

  it("first-year discount stacks on a forced-LCT rate → 15.5%", () => {
    const cfg = {
      ...base,
      limited_cost: "yes" as const,
      registration_date: "2026-03-01",
      first_year_discount: true,
    };
    const r = resolveFlatRateForPeriod(cfg, Q_START, Q_END, 10_000, 9_000);
    expect(r.effectivePercent).toBe(15.5);
  });
});

describe("FRS turnover + relevant-goods helpers align with the window", () => {
  const inv = { vat_total: 200, amount: 1000, total: 1200 };

  it("flatRateTurnoverInclVat (cash) sums gross cash received in the window", () => {
    const payments = [
      payment("2026-05-10", inv),
      payment("2026-08-10", inv), // out of window
    ];
    expect(flatRateTurnoverInclVat(payments, [], Q_START, Q_END, "cash")).toBe(1200);
  });

  it("flatRateTurnoverInclVat (standard) sums gross of issued invoices in the window", () => {
    const invoices = [
      invoice("2026-04-15", "sent", inv),
      invoice("2026-04-15", "draft", inv), // not issued
      invoice("2026-09-15", "sent", inv), // out of window
    ];
    expect(flatRateTurnoverInclVat([], invoices, Q_START, Q_END, "standard")).toBe(1200);
  });

  it("relevantGoodsInclVat sums gross (net + VAT) of logged costs in the window", () => {
    const finances = [
      { vat_total: 20, amount: 100, created_at: "2026-05-02" },
      { vat_total: 0, amount: 300, created_at: "2026-01-01" }, // out of window
    ];
    expect(relevantGoodsInclVat(finances, Q_START, Q_END)).toBe(120);
  });
});
