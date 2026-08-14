import { describe, it, expect } from "vitest";
import {
  computeVatQuarter,
  computeVatNetTotals,
  computePayeMonth,
  computeCorpTaxYear,
  startOfQuarterIso,
  endOfQuarterExclusiveIso,
  startOfTaxYearIso,
  type InvoicePaymentRow,
} from "@/lib/tax/compute";
import {
  gatherVatQuarterInputs,
  type VatInputsDb,
} from "@/server/services/vat-quarter-inputs";

/** A FULL payment of an invoice — the ledger sum equals the old full-amount path. */
function fullPayment(
  paidAt: string | null,
  invoice: { vat_total: number | string; amount: number | string; total: number | string },
): InvoicePaymentRow {
  return {
    amount: invoice.total,
    paid_at: paidAt,
    invoice_vat_total: invoice.vat_total,
    invoice_amount: invoice.amount,
    invoice_total: invoice.total,
  };
}

describe("computeVatQuarter", () => {
  const quarterStart = "2026-04-01";

  it("sums output VAT only from payments received within the quarter", () => {
    // Fully-paid invoices become full payments — the ledger sum equals the old
    // full-amount path, so the boxes are unchanged.
    const payments: InvoicePaymentRow[] = [
      fullPayment("2026-04-10", { vat_total: 200, total: 1200, amount: 1000 }), // in — 200
      fullPayment("2026-05-15", { vat_total: 50, total: 250, amount: 200 }), // in — 50
      // A `sent` (never-paid) invoice has NO payment row → contributes nothing.
      fullPayment("2026-03-31", { vat_total: 999, total: 5994, amount: 4995 }), // paid before — excluded
    ];
    const result = computeVatQuarter(payments, [], quarterStart);
    expect(result.output_vat).toBe(250);
    expect(result.input_vat).toBe(0);
    expect(result.net_payable).toBe(250);
    expect(result.confidence).toBe("computed");
  });

  it("subtracts input VAT from finance rows created within the quarter", () => {
    const finances = [
      { vat_total: 40, amount: 200, created_at: "2026-04-12" }, // in
      { vat_total: 20, amount: 100, created_at: "2026-05-01" }, // in
      { vat_total: 999, amount: 4995, created_at: "2026-03-15" }, // before, excluded
    ];
    const result = computeVatQuarter([], finances, quarterStart);
    expect(result.input_vat).toBe(60);
    expect(result.output_vat).toBe(0);
    expect(result.net_payable).toBe(-60);
  });

  it("handles string-encoded numbers (Supabase numerics arrive as strings)", () => {
    const payments: InvoicePaymentRow[] = [
      fullPayment("2026-04-10", { vat_total: "200.50", total: "1200.50", amount: "1000" }),
    ];
    const finances = [
      { vat_total: "40.25", amount: "201.25", created_at: "2026-04-12" },
    ];
    const result = computeVatQuarter(payments, finances, quarterStart);
    expect(result.output_vat).toBe(200.5);
    expect(result.input_vat).toBe(40.25);
    expect(result.net_payable).toBe(160.25);
  });

  it("EXCLUDES future-dated paid_at / created_at when given an exclusive upper bound", () => {
    // Quarter = 2026-04-01 .. 2026-07-01 (exclusive). Rows dated in the NEXT
    // quarter must not leak into this one's output/input VAT.
    const quarterEnd = "2026-07-01";
    const payments: InvoicePaymentRow[] = [
      fullPayment("2026-05-10", { vat_total: 200, total: 1200, amount: 1000 }), // in
      fullPayment("2026-07-01", { vat_total: 500, total: 3000, amount: 2500 }), // next quarter (exclusive) — OUT
      fullPayment("2026-09-15", { vat_total: 999, total: 5994, amount: 4995 }), // future — OUT
    ];
    const finances = [
      { vat_total: 40, amount: 200, created_at: "2026-06-30" }, // in
      { vat_total: 88, amount: 440, created_at: "2026-07-15" }, // next quarter — OUT
    ];
    const result = computeVatQuarter(payments, finances, quarterStart, quarterEnd);
    expect(result.output_vat).toBe(200); // future-dated 500 + 999 excluded
    expect(result.input_vat).toBe(40); // future-dated 88 excluded
    expect(result.net_payable).toBe(160);
  });

  it("without an upper bound, keeps the historical open-ended behaviour (leak reproduced)", () => {
    // With no upper bound a future-dated payment DOES flow in. Every live consumer
    // passes the bound, so this path is only the documented default.
    const payments: InvoicePaymentRow[] = [
      fullPayment("2026-05-10", { vat_total: 200, total: 1200, amount: 1000 }),
      fullPayment("2026-09-15", { vat_total: 500, total: 3000, amount: 2500 }),
    ];
    const unbounded = computeVatQuarter(payments, [], quarterStart);
    expect(unbounded.output_vat).toBe(700); // 200 + the future-dated 500 leaks in
    const bounded = computeVatQuarter(payments, [], quarterStart, "2026-07-01");
    expect(bounded.output_vat).toBe(200);
  });

  it("is the single VAT authority the quarterly PDF reuses — same rows, same totals", () => {
    // The PDF, tile and 9-box all read output_vat/input_vat/net_payable off this
    // authority over the same window, so they can never drift.
    const quarterEnd = "2026-07-01";
    const payments: InvoicePaymentRow[] = [
      fullPayment("2026-04-10", { vat_total: 600, total: 3600, amount: 3000 }),
      fullPayment("2026-06-30", { vat_total: 400, total: 2400, amount: 2000 }),
      fullPayment("2026-08-01", { vat_total: 999, total: 5994, amount: 4995 }), // future — must not count
    ];
    const finances = [
      { vat_total: 150, amount: 750, created_at: "2026-05-05" },
      { vat_total: 50, amount: 250, created_at: "2026-06-15" },
    ];
    const authority = computeVatQuarter(payments, finances, quarterStart, quarterEnd);
    expect(authority.output_vat).toBe(1000);
    expect(authority.input_vat).toBe(200);
    expect(authority.net_payable).toBe(800);
  });

  // ── GAP 2 — cash-basis output VAT from the payment ledger (partial payments) ──
  describe("cash-basis output VAT includes PARTIAL payments (GAP 2)", () => {
    const quarterEnd = "2026-07-01";

    it("a partial payment contributes payment × vat_total/total, not £0 and not the full VAT", () => {
      // A £1,200 invoice (net £1,000 + £200 VAT). Only £600 has been received in
      // the quarter — the invoice is `partially_paid`, so status≠'paid' and
      // invoices.paid_at is NULL. The OLD status-gated path contributed £0 for
      // this quarter; the ledger contributes the VAT on the cash actually taken.
      const partial: InvoicePaymentRow[] = [
        { amount: 600, paid_at: "2026-05-01", invoice_vat_total: 200, invoice_amount: 1000, invoice_total: 1200 },
      ];
      const result = computeVatQuarter(partial, [], quarterStart, quarterEnd);
      // 600 × (200 / 1200) = 100 — half the invoice's VAT, because half the cash landed.
      expect(result.output_vat).toBe(100);
      const netTotals = computeVatNetTotals(partial, [], quarterStart, quarterEnd);
      expect(netTotals.totalValueSalesExVAT).toBe(500); // 600 × (1000/1200)

      // RED→GREEN proof: the OLD status flag on a partially_paid invoice was £0.
      const oldStatusGated = 0;
      expect(result.output_vat).not.toBe(oldStatusGated);
    });

    it("an instalment paid across TWO quarters splits correctly", () => {
      // £1,200 invoice, two £600 instalments, one in each quarter.
      const q2Payment: InvoicePaymentRow = {
        amount: 600, paid_at: "2026-06-20", invoice_vat_total: 200, invoice_amount: 1000, invoice_total: 1200,
      };
      const q3Payment: InvoicePaymentRow = {
        amount: 600, paid_at: "2026-07-05", invoice_vat_total: 200, invoice_amount: 1000, invoice_total: 1200,
      };
      const ledger = [q2Payment, q3Payment];
      const q2 = computeVatQuarter(ledger, [], "2026-04-01", "2026-07-01");
      const q3 = computeVatQuarter(ledger, [], "2026-07-01", "2026-10-01");
      expect(q2.output_vat).toBe(100); // only the Q2 instalment
      expect(q3.output_vat).toBe(100); // only the Q3 instalment
      // The two quarters sum to the whole invoice's VAT — nothing lost, nothing doubled.
      expect(q2.output_vat + q3.output_vat).toBe(200);
    });

    it("a fully-paid invoice still yields the SAME boxes as the old full-amount path", () => {
      const full = computeVatQuarter(
        [fullPayment("2026-05-01", { vat_total: 200, total: 1200, amount: 1000 })],
        [],
        quarterStart,
        quarterEnd,
      );
      expect(full.output_vat).toBe(200); // == the invoice's whole vat_total
      const netTotals = computeVatNetTotals(
        [fullPayment("2026-05-01", { vat_total: 200, total: 1200, amount: 1000 })],
        [],
        quarterStart,
        quarterEnd,
      );
      expect(netTotals.totalValueSalesExVAT).toBe(1000); // == the invoice's whole net
    });

    it("guards divide-by-zero (invoice total = 0) and NULLs", () => {
      const bad: InvoicePaymentRow[] = [
        { amount: 500, paid_at: "2026-05-01", invoice_vat_total: 50, invoice_amount: 450, invoice_total: 0 },
        { amount: 500, paid_at: "2026-05-01", invoice_vat_total: null, invoice_amount: null, invoice_total: null },
      ];
      const result = computeVatQuarter(bad, [], quarterStart, quarterEnd);
      expect(result.output_vat).toBe(0); // both rows skipped, no NaN
      expect(Number.isNaN(result.output_vat)).toBe(false);
    });
  });

  // ── GAP 1 — domestic reverse-charge VAT into boxes 1, 4 and 7 ─────────────────
  // A domestic reverse-charge (S55A) subcontractor BILL is a real `finances` row:
  // net in `amount`, `vat_total` 0 (the supplier charges no VAT). Its notional VAT
  // is frozen on the allocation and passed to computeVatQuarter as reverseChargeVat.
  // Every fixture below uses that REAL production shape — the RC bill IS in
  // `finances` — because the earlier test omitted it and thereby masked the box-7
  // double-count fixed in C69.
  describe("domestic reverse-charge VAT enters boxes 1, 4 and 7 (GAP 1)", () => {
    const quarterEnd = "2026-07-01";

    it("raises box 1 AND box 4 by the notional VAT ONCE while box 5 net stays UNCHANGED", () => {
      const payments = [fullPayment("2026-05-01", { vat_total: 200, total: 1200, amount: 1000 })];
      // Real shape: a standard purchase PLUS the reverse-charge bill (vat_total 0).
      const finances = [
        { vat_total: 40, amount: 200, created_at: "2026-05-02" }, // standard purchase
        { vat_total: 0, amount: 1500, created_at: "2026-05-03" }, // the reverse-charge bill
      ];

      const without = computeVatQuarter(payments, finances, quarterStart, quarterEnd);
      const withRc = computeVatQuarter(payments, finances, quarterStart, quarterEnd, 300);

      // Box 4 with reverseChargeVat=0 is just the standard purchase's £40 — the RC
      // bill's own vat_total is 0, so its presence in `finances` does NOT inflate box 4.
      expect(without.input_vat).toBe(40);
      // Box 1 and box 4 each rise by the £300 notional VAT — exactly once...
      expect(withRc.output_vat).toBe(without.output_vat + 300);
      expect(withRc.input_vat).toBe(without.input_vat + 300);
      // ...so box 5 (net) is net-neutral — the whole point of the reverse charge.
      expect(withRc.net_payable).toBe(without.net_payable);
    });

    it("counts the reverse-charge purchase net in box 7 EXACTLY ONCE — 1500, not the C67 double-count 3000", () => {
      const payments = [fullPayment("2026-05-01", { vat_total: 200, total: 1200, amount: 1000 })];
      // The reverse-charge bill alone, as production stores it in `finances`.
      const rcBillOnly = [{ vat_total: 0, amount: 1500, created_at: "2026-05-03" }];

      const net = computeVatNetTotals(payments, rcBillOnly, quarterStart, quarterEnd);

      // Box 6 (sales) is untouched by a reverse-charge PURCHASE.
      expect(net.totalValueSalesExVAT).toBe(1000);
      // Box 7: the RC net enters via the finances loop ONCE = 1500. Before the C69
      // fix the SAME net was ALSO added via a separate reverseChargeNet argument,
      // so box 7 froze at 1500 + 1500 = 3000 on the HMRC payload.
      expect(net.totalValuePurchasesExVAT).toBe(1500);
      expect(net.totalValuePurchasesExVAT).not.toBe(3000); // the removed double-count
    });

    it("a standard purchase still lands in box 7 once, alongside the reverse-charge bill", () => {
      const payments = [fullPayment("2026-05-01", { vat_total: 200, total: 1200, amount: 1000 })];
      const finances = [
        { vat_total: 40, amount: 200, created_at: "2026-05-02" }, // standard purchase net 200
        { vat_total: 0, amount: 1500, created_at: "2026-05-03" }, // reverse-charge bill net 1500
      ];
      const net = computeVatNetTotals(payments, finances, quarterStart, quarterEnd);
      // 200 + 1500, each counted once.
      expect(net.totalValuePurchasesExVAT).toBe(1700);
    });
  });
});

describe("dashboard 'VAT this quarter' tile — regression: 6-month window must not leak earlier-quarter input VAT", () => {
  // The dashboard loads a 6-MONTH finances window (for the profitability charts)
  // and used to hand-roll a SECOND VAT calculator that summed input VAT across
  // EVERY loaded finance row with no quarter gate. The tile now calls the single
  // authority with an exclusive upper bound, exactly as the page does.
  const quarterStart = "2026-07-01T00:00:00.000Z"; // current quarter = Q3 (Jul–Sep)
  const quarterEnd = endOfQuarterExclusiveIso(quarterStart);

  const payments: InvoicePaymentRow[] = [
    // Paid in the current quarter → output VAT counts
    fullPayment("2026-07-05", { vat_total: 400, total: 2400, amount: 2000 }),
    // Paid in the EARLIER quarter → excluded
    fullPayment("2026-05-01", { vat_total: 999, total: 5994, amount: 4995 }),
  ];
  const finances = [
    // EARLIER quarter (Q2) input VAT — the leg the buggy calculator wrongly summed
    { vat_total: 500, amount: 2500, created_at: "2026-05-15" },
    // Current-quarter (Q3) input VAT — the only input that belongs to this return
    { vat_total: 100, amount: 500, created_at: "2026-07-10" },
    { vat_total: 50, amount: 250, created_at: "2026-08-20" },
  ];

  it("gates BOTH legs to the current quarter — earlier-quarter input VAT is excluded", () => {
    const vat = computeVatQuarter(payments, finances, quarterStart, quarterEnd);
    expect(vat.output_vat).toBe(400); // Q2 payment excluded
    expect(vat.input_vat).toBe(150); // 100 + 50; the £500 Q2 cost is NOT summed
    expect(vat.net_payable).toBe(250);
    expect(vat.confidence).toBe("computed");
  });

  it("net VAT is HIGHER than the old 'sum all loaded finances' bug produced (understatement removed)", () => {
    const fixed = computeVatQuarter(payments, finances, quarterStart, quarterEnd);
    const buggyInputVat = finances.reduce((s, f) => s + Number(f.vat_total ?? 0), 0);
    const buggyNetVat = fixed.output_vat - buggyInputVat; // 400 − 650 = −250
    expect(buggyInputVat).toBe(650);
    expect(buggyNetVat).toBe(-250);
    expect(fixed.net_payable).toBeGreaterThan(buggyNetVat);
    expect(fixed.net_payable - buggyNetVat).toBe(500);
  });
});

describe("computePayeMonth", () => {
  it("returns a placeholder until payroll lands", () => {
    const r = computePayeMonth();
    expect(r.estimate).toBe(0);
    expect(r.confidence).toBe("placeholder");
    expect(r.note).toMatch(/payroll/i);
  });

  it("sums PAYE + employee NI + EMPLOYER NI from this month's payroll runs — the computed path the tax page consumes", () => {
    const now = new Date("2026-05-19T00:00:00Z");
    const r = computePayeMonth(
      [
        {
          paye_estimate: 120,
          ni_estimate: 30,
          gross_pay: 3_000,
          run: { period_start: "2026-05-01", status: "finalised", cycle: "monthly" },
        },
        {
          paye_estimate: 80,
          ni_estimate: 20,
          gross_pay: 600,
          run: { period_start: "2026-05-12", status: "draft", cycle: "weekly" },
        },
        {
          // Previous month — excluded from this month's liability, gross and all.
          paye_estimate: 999,
          ni_estimate: 999,
          gross_pay: 99_999,
          run: { period_start: "2026-04-01", status: "finalised", cycle: "monthly" },
        },
      ],
      now,
    );
    expect(r.confidence).toBe("computed");
    expect(r.paye_estimate).toBe(200); // 120 + 80
    expect(r.employee_ni_estimate).toBe(50); // 30 + 20
    // Employer NI, 2026-27 rates (15% above a £5,000 secondary threshold):
    //   monthly £3,000  → annualised 36,000 → (36,000 − 5,000) × 15% = 4,650 /12 = 387.50
    //   weekly  £600    → annualised 31,200 → (31,200 − 5,000) × 15% = 3,930 /52 =  75.58
    expect(r.employer_ni_estimate).toBe(463.08);
    // The HMRC bill is PAYE + employee NI + employer NI.
    expect(r.estimate).toBe(713.08);
    expect(r.note).toMatch(/22nd/); // due date the liabilities row surfaces
    expect(r.note).toMatch(/employer NI/);
    // It is an ESTIMATE, and the Employment Allowance caveat must travel with it.
    expect(r.note).toMatch(/Estimate/);
    expect(r.note).toMatch(/Employment Allowance/);
  });

  it("EXCLUDES employer pension from the HMRC liability (it is paid to the provider, not HMRC)", () => {
    const now = new Date("2026-05-19T00:00:00Z");
    const r = computePayeMonth(
      [
        {
          paye_estimate: 0,
          ni_estimate: 0,
          gross_pay: 3_000,
          run: { period_start: "2026-05-01", status: "finalised", cycle: "monthly" },
        },
      ],
      now,
    );
    // Employer pension on this gross is 3% × (36,000 − 6,240) / 12 = £74.40. If it
    // had leaked into the HMRC figure the estimate would be 461.90, not 387.50.
    expect(r.employer_ni_estimate).toBe(387.5);
    expect(r.estimate).toBe(387.5);
  });

  it("prices each run at the rates in force for ITS OWN period, not today's", () => {
    // A 2024-25 period (13.8% above £9,100) must not be re-priced at 2026-27 rates
    // (15% above £5,000) just because it is being read now.
    const r = computePayeMonth(
      [
        {
          paye_estimate: 0,
          ni_estimate: 0,
          gross_pay: 3_000,
          run: { period_start: "2024-06-01", status: "finalised", cycle: "monthly" },
        },
      ],
      new Date("2024-06-15T00:00:00Z"),
    );
    // (36,000 − 9,100) × 13.8% = 3,712.20 / 12 = £309.35 — the 2024-25 answer.
    expect(r.employer_ni_estimate).toBe(309.35);
  });
});

describe("computeCorpTaxYear", () => {
  const yearStart = "2026-04-06"; // UK tax year start

  it("applies the small profits rate (19%) for profits under £50k", () => {
    const invoices = [
      { status: "paid", vat_total: 0, total: 30_000, amount: 30_000, paid_at: "2026-05-01", created_at: "2026-05-01" },
    ];
    const finances = [
      { vat_total: 0, amount: 5_000, created_at: "2026-05-02" },
    ];
    const r = computeCorpTaxYear(invoices, finances, yearStart);
    expect(r.estimated_profit).toBe(25_000);
    expect(r.rate_applied).toBe(19);
    expect(r.estimated_tax).toBe(25_000 * 0.19);
    expect(r.confidence).toBe("computed");
  });

  it("applies the main rate (25%) for profits over £250k", () => {
    const invoices = [
      { status: "paid", vat_total: 0, total: 400_000, amount: 400_000, paid_at: "2026-05-01", created_at: "2026-05-01" },
    ];
    const finances = [
      { vat_total: 0, amount: 50_000, created_at: "2026-05-02" },
    ];
    const r = computeCorpTaxYear(invoices, finances, yearStart);
    expect(r.estimated_profit).toBe(350_000);
    expect(r.rate_applied).toBe(25);
    expect(r.estimated_tax).toBe(350_000 * 0.25);
  });

  it("applies HMRC marginal relief between £50k and £250k (3/200 fraction)", () => {
    const invoices = [
      { status: "paid", vat_total: 0, total: 150_000, amount: 150_000, paid_at: "2026-05-01", created_at: "2026-05-01" },
    ];
    const r = computeCorpTaxYear(invoices, [], yearStart);
    expect(r.estimated_profit).toBe(150_000);
    // HMRC formula: 150,000×25% − (250,000 − 150,000)×3/200
    //             = 37,500 − 1,500 = £36,000  (NOT the old linear £33,000).
    // Effective rate 36,000 / 150,000 = 24.00%.
    expect(r.estimated_tax).toBe(36_000);
    expect(r.rate_applied).toBe(24);
  });

  it("marginal relief is continuous at the £50k lower boundary (= flat 19%)", () => {
    const r = computeCorpTaxYear(
      [{ status: "paid", vat_total: 0, total: 50_000, amount: 50_000, paid_at: "2026-05-01", created_at: "2026-05-01" }],
      [],
      yearStart,
    );
    expect(r.estimated_profit).toBe(50_000);
    // 50,000×25% − (250,000 − 50,000)×3/200 = 12,500 − 3,000 = 9,500 = 50,000×19%.
    expect(r.estimated_tax).toBe(9_500);
    expect(r.rate_applied).toBe(19);
  });

  it("marginal relief is continuous at the £250k upper boundary (= flat 25%)", () => {
    // £249,999 sits inside the marginal band; relief is a rounding-negligible £0.02
    // below the £62,500 that £250,000 pays flat, so the effective rate is ~25%.
    const r = computeCorpTaxYear(
      [{ status: "paid", vat_total: 0, total: 250_000, amount: 250_000, paid_at: "2026-05-01", created_at: "2026-05-01" }],
      [],
      yearStart,
    );
    expect(r.estimated_profit).toBe(250_000);
    // At exactly £250k relief is nil: 250,000×25% − 0 = £62,500.
    expect(r.estimated_tax).toBe(62_500);
    expect(r.rate_applied).toBe(25);
  });

  it("never produces a negative profit (clamps to 0 when costs exceed revenue)", () => {
    const r = computeCorpTaxYear(
      [{ status: "paid", vat_total: 0, total: 1000, amount: 1000, paid_at: "2026-05-01", created_at: "2026-05-01" }],
      [{ vat_total: 0, amount: 5000, created_at: "2026-05-02" }],
      yearStart,
    );
    expect(r.estimated_profit).toBe(0);
    expect(r.estimated_tax).toBe(0);
  });

  it("excludes rows from before the tax year start", () => {
    const invoices = [
      { status: "paid", vat_total: 0, total: 100_000, amount: 100_000, paid_at: "2026-05-01", created_at: "2026-05-01" },
      // Pre-year, excluded
      { status: "paid", vat_total: 0, total: 999_999, amount: 999_999, paid_at: "2026-03-01", created_at: "2026-03-01" },
    ];
    const r = computeCorpTaxYear(invoices, [], yearStart);
    expect(r.estimated_profit).toBe(100_000);
  });

  it("EXCLUDES draft (never-issued) invoices from revenue — the launch-blocking fix", () => {
    // `draft` is the schema/new-invoice default: every invoice is a draft carrying
    // real line amounts before it is sent. Counting it as revenue overstated profit
    // and the CT estimate for essentially every org, contradicting the accrual basis.
    const r = computeCorpTaxYear(
      [{ status: "draft", vat_total: 0, total: 30_000, amount: 30_000, paid_at: null, created_at: "2026-05-01" }],
      [],
      yearStart,
    );
    expect(r.estimated_profit).toBe(0);
    expect(r.estimated_tax).toBe(0);
  });

  it("COUNTS issued invoices (sent, paid) of the same amount that a draft does not", () => {
    // A £30k draft contributes £0 (above); a £30k `sent` and a £30k `paid` each
    // contribute in full, on the accrual basis, regardless of payment.
    const sent = computeCorpTaxYear(
      [{ status: "sent", vat_total: 0, total: 30_000, amount: 30_000, paid_at: null, created_at: "2026-05-01" }],
      [],
      yearStart,
    );
    expect(sent.estimated_profit).toBe(30_000);
    expect(sent.estimated_tax).toBe(30_000 * 0.19);

    const paid = computeCorpTaxYear(
      [{ status: "paid", vat_total: 0, total: 30_000, amount: 30_000, paid_at: "2026-05-10", created_at: "2026-05-01" }],
      [],
      yearStart,
    );
    expect(paid.estimated_profit).toBe(30_000);
    expect(paid.estimated_tax).toBe(30_000 * 0.19);
  });

  it("counts all issued statuses but never draft in a mixed set", () => {
    // Issued: sent + awaiting_payment + partially_paid + paid + legacy overdue =
    // 5 × £10k = £50k. The two £10k drafts are excluded. Costs £0 ⇒ profit £50k.
    const invoices = [
      { status: "sent", vat_total: 0, total: 10_000, amount: 10_000, paid_at: null, created_at: "2026-05-01" },
      { status: "awaiting_payment", vat_total: 0, total: 10_000, amount: 10_000, paid_at: null, created_at: "2026-05-02" },
      { status: "partially_paid", vat_total: 0, total: 10_000, amount: 10_000, paid_at: null, created_at: "2026-05-03" },
      { status: "paid", vat_total: 0, total: 10_000, amount: 10_000, paid_at: "2026-05-05", created_at: "2026-05-04" },
      { status: "overdue", vat_total: 0, total: 10_000, amount: 10_000, paid_at: null, created_at: "2026-05-06" },
      { status: "draft", vat_total: 0, total: 10_000, amount: 10_000, paid_at: null, created_at: "2026-05-07" },
      { status: "draft", vat_total: 0, total: 10_000, amount: 10_000, paid_at: null, created_at: "2026-05-08" },
    ];
    const r = computeCorpTaxYear(invoices, [], yearStart);
    expect(r.estimated_profit).toBe(50_000);
  });
});

describe("startOfQuarterIso", () => {
  it("returns Apr 1 for any date in Q2 (calendar)", () => {
    expect(startOfQuarterIso(new Date("2026-05-15T12:00:00Z"))).toBe("2026-04-01");
    expect(startOfQuarterIso(new Date("2026-04-01T00:00:00Z"))).toBe("2026-04-01");
    expect(startOfQuarterIso(new Date("2026-06-30T23:59:59Z"))).toBe("2026-04-01");
  });
  it("returns Jan 1 for January", () => {
    expect(startOfQuarterIso(new Date("2026-01-10T00:00:00Z"))).toBe("2026-01-01");
  });
  it("returns Oct 1 for December", () => {
    expect(startOfQuarterIso(new Date("2026-12-31T00:00:00Z"))).toBe("2026-10-01");
  });
});

describe("startOfTaxYearIso", () => {
  it("rolls back to the previous April when current date is before 6 April", () => {
    expect(startOfTaxYearIso(new Date("2026-03-15T00:00:00Z"))).toBe("2025-04-06");
    expect(startOfTaxYearIso(new Date("2026-04-05T00:00:00Z"))).toBe("2025-04-06");
  });
  it("uses the current April when date is on/after 6 April", () => {
    expect(startOfTaxYearIso(new Date("2026-04-06T00:00:00Z"))).toBe("2026-04-06");
    expect(startOfTaxYearIso(new Date("2026-05-20T00:00:00Z"))).toBe("2026-04-06");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C73-A — the READ-LAYER guard (the de-vacuum). VAT-box reconciliation class,
// sibling to C67/C68/C69.
// ═══════════════════════════════════════════════════════════════════════════
// WHY THE PURE-FN TESTS ABOVE ARE VACUOUS FOR THIS CLASS. Every test above hands
// PRE-WINDOWED rows + a scalar `reverseChargeVat` to the pure function for ONE
// quarter, so it can NEVER exercise the bug: the defect lives in the READ LAYER
// (server/services/vat-quarter-inputs.ts), which windows the reverse-charge
// notional VAT on ONE date column and box 7's net on ANOTHER. To exercise it we
// must drive the real `gatherVatQuarterInputs` against a seeded DB over TWO
// quarter windows and prove all of boxes 1, 4 AND 7 land in the SAME quarter.
//
// THE DEFECT (pre-fix). `gatherReverseChargeQuarter` windowed the RC notional VAT
// on `supplier_payments.paid_at`, while the RC bill's NET (box 7) is windowed on
// `finances.created_at` (the RC bill IS a finances row). A bill LOGGED in Q1 but
// PAID in Q2 — a normal CIS payables flow — therefore SPLIT: Q1 got the box-7 net
// with £0 in boxes 1/4; Q2 got the boxes-1/4 VAT with no box-7 net. The frozen
// HMRC 9-box return no longer reconciled. The fix windows the RC VAT on the SAME
// `finances.created_at` as box 7, so a single RC transaction stays in ONE quarter.
describe("C73-A read-layer: reverse-charge boxes 1/4/7 reconcile in ONE quarter", () => {
  // A minimal in-memory PostgREST double that honours the exact predicates the
  // read layer uses (eq/gte/lt/is/in/order/range/thenable), filtering + paging a
  // seeded table set — the same shape as __tests__/reports/aggregates.test.ts.
  function makeDb(tables: Record<string, Array<Record<string, unknown>>>): VatInputsDb {
    function makeBuilder(table: string) {
      const eqs: Array<[string, unknown]> = [];
      const gtes: Array<[string, unknown]> = [];
      const lts: Array<[string, unknown]> = [];
      const iss: Array<[string, unknown]> = [];
      const ins: Array<[string, readonly unknown[]]> = [];
      const orders: Array<[string, boolean]> = [];

      const filteredOrdered = () => {
        let rows = (tables[table] ?? []).filter((row) => {
          for (const [c, v] of eqs) if (row[c] !== v) return false;
          for (const [c, v] of gtes) {
            if (row[c] == null) return false;
            if (String(row[c]) < String(v)) return false;
          }
          for (const [c, v] of lts) {
            if (row[c] == null) return false;
            if (String(row[c]) >= String(v)) return false;
          }
          for (const [c, v] of iss) if ((row[c] ?? null) !== v) return false;
          for (const [c, list] of ins) if (!list.includes(row[c])) return false;
          return true;
        });
        for (let i = orders.length - 1; i >= 0; i--) {
          const [c, asc] = orders[i]!;
          rows = [...rows].sort((a, b) => {
            const av = a[c] as string | number;
            const bv = b[c] as string | number;
            if (av === bv) return 0;
            return (av < bv ? -1 : 1) * (asc ? 1 : -1);
          });
        }
        return rows;
      };

      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (c: string, v: unknown) => (eqs.push([c, v]), builder),
        gte: (c: string, v: unknown) => (gtes.push([c, v]), builder),
        lt: (c: string, v: unknown) => (lts.push([c, v]), builder),
        is: (c: string, v: unknown) => (iss.push([c, v]), builder),
        in: (c: string, list: readonly unknown[]) => (ins.push([c, list]), builder),
        order: (c: string, o?: { ascending?: boolean }) =>
          (orders.push([c, o?.ascending !== false]), builder),
        range: (from: number, to: number) =>
          Promise.resolve({ data: filteredOrdered().slice(from, to + 1), error: null }),
        then: (onF: (v: { data: unknown[]; error: null }) => unknown) =>
          onF({ data: filteredOrdered(), error: null }),
      };
      return builder;
    }
    return { from: (t: string) => makeBuilder(t) } as unknown as VatInputsDb;
  }

  const ORG = "org-1";
  const Q1_START = "2026-04-01";
  const Q1_END = "2026-07-01"; // exclusive
  const Q2_START = "2026-07-01";
  const Q2_END = "2026-10-01"; // exclusive

  // A CIS domestic reverse-charge BILL logged in Q1 (finances.created_at) and
  // PAID in Q2 (supplier_payments.paid_at) — the exact cross-quarter payables flow.
  // Net £1,500, notional VAT £300, no VAT charged by the supplier (vat_total 0).
  function seed() {
    return {
      finances: [
        {
          id: "fin-rc",
          org_id: ORG,
          vat_total: 0,
          amount: 1500,
          created_at: "2026-05-10T09:00:00.000Z", // Q1
        },
      ],
      supplier_payments: [
        { id: "sp-1", org_id: ORG, voided_at: null, paid_at: "2026-08-20" }, // Q2
      ],
      supplier_payment_allocations: [
        {
          id: "spa-1",
          org_id: ORG,
          payment_id: "sp-1",
          finance_id: "fin-rc",
          amount: 1500,
          cis_reverse_charge_vat: 300,
          cis_vat_treatment: "reverse_charge",
        },
      ],
    };
  }

  it("puts boxes 1, 4 AND 7 in the BILL's quarter (Q1); Q2 shows none of them", async () => {
    const tables = seed();
    const db = makeDb(tables);
    const financeRows = tables.finances.map((f) => ({
      vat_total: f.vat_total as number,
      amount: f.amount as number,
      created_at: f.created_at as string,
    }));

    // ── Q1 (the bill's quarter) — all three boxes present ────────────────────
    const q1Inputs = await gatherVatQuarterInputs(db, ORG, Q1_START, Q1_END);
    expect(q1Inputs.reverseCharge.vat).toBe(300); // RC VAT windowed on the bill's created_at
    const q1Vat = computeVatQuarter(
      q1Inputs.invoicePayments,
      financeRows,
      Q1_START,
      Q1_END,
      q1Inputs.reverseCharge.vat,
    );
    const q1Net = computeVatNetTotals(q1Inputs.invoicePayments, financeRows, Q1_START, Q1_END);
    expect(q1Vat.output_vat).toBe(300); // box 1
    expect(q1Vat.input_vat).toBe(300); // box 4 (net-neutral)
    expect(q1Vat.net_payable).toBe(0); // box 5 stays neutral
    expect(q1Net.totalValuePurchasesExVAT).toBe(1500); // box 7 net

    // ── Q2 (the payment's quarter) — none of the three boxes ─────────────────
    const q2Inputs = await gatherVatQuarterInputs(makeDb(seed()), ORG, Q2_START, Q2_END);
    expect(q2Inputs.reverseCharge.vat).toBe(0); // NOT keyed off paid_at any more
    const q2Vat = computeVatQuarter(
      q2Inputs.invoicePayments,
      financeRows,
      Q2_START,
      Q2_END,
      q2Inputs.reverseCharge.vat,
    );
    const q2Net = computeVatNetTotals(q2Inputs.invoicePayments, financeRows, Q2_START, Q2_END);
    expect(q2Vat.output_vat).toBe(0); // box 1
    expect(q2Vat.input_vat).toBe(0); // box 4
    expect(q2Net.totalValuePurchasesExVAT).toBe(0); // box 7 — the bill isn't in Q2

    // ── The invariant: boxes 1/4/7 all move TOGETHER into the SAME quarter ───
    // Pre-fix (paid_at windowing) this failed: Q1 had box 7 = 1500 but boxes 1/4
    // = 0, while Q2 had boxes 1/4 = 300 but box 7 = 0 — the split HMRC rejects.
    const q1HasNet = q1Net.totalValuePurchasesExVAT > 0;
    const q1HasVat = q1Vat.output_vat > 0;
    const q2HasNet = q2Net.totalValuePurchasesExVAT > 0;
    const q2HasVat = q2Vat.output_vat > 0;
    expect(q1HasNet).toBe(q1HasVat); // both true in Q1
    expect(q2HasNet).toBe(q2HasVat); // both false in Q2
  });

  it("delete-the-fix reproduction: the OLD paid_at windowing SPLITS the boxes", () => {
    // Documents (and locks in) the reproduction the fix removes. Windowing the RC
    // VAT on the PAYMENT's paid_at (the old basis) puts the notional VAT in Q2,
    // while the bill's net (box 7) is always in Q1 on created_at — so no single
    // quarter carries both. This is a pure counterfactual over the SAME fixture.
    const tables = seed();
    const alloc = tables.supplier_payment_allocations[0]!;
    const pay = tables.supplier_payments.find((p) => p.id === alloc.payment_id)!;
    const bill = tables.finances.find((f) => f.id === alloc.finance_id)!;

    const inWindow = (iso: string, start: string, endExcl: string) =>
      iso >= start && iso < endExcl;

    // OLD basis: RC VAT keyed off the payment's paid_at (Q2).
    const oldRcInQ1 = inWindow(pay.paid_at as string, Q1_START, Q1_END)
      ? Number(alloc.cis_reverse_charge_vat)
      : 0;
    const oldRcInQ2 = inWindow(pay.paid_at as string, Q2_START, Q2_END)
      ? Number(alloc.cis_reverse_charge_vat)
      : 0;
    // Box 7 net keyed off the bill's created_at (Q1) — same in old and new.
    const netInQ1 = inWindow(bill.created_at as string, Q1_START, Q1_END)
      ? Number(bill.amount)
      : 0;
    const netInQ2 = inWindow(bill.created_at as string, Q2_START, Q2_END)
      ? Number(bill.amount)
      : 0;

    // The SPLIT: Q1 has net but no RC VAT; Q2 has RC VAT but no net.
    expect(oldRcInQ1).toBe(0);
    expect(netInQ1).toBe(1500);
    expect(oldRcInQ2).toBe(300);
    expect(netInQ2).toBe(0);
    // Neither quarter reconciles under the old basis — the defect, made concrete.
    expect(oldRcInQ1 > 0).not.toBe(netInQ1 > 0);
    expect(oldRcInQ2 > 0).not.toBe(netInQ2 > 0);
  });

  it("KEEPS the voided-payment exclusion (a voided payment contributes no RC VAT)", async () => {
    const tables = seed();
    // Void the only payment: its allocation survives (the record of what it
    // claimed) but must NOT count toward any filed VAT figure.
    (tables.supplier_payments[0]! as Record<string, unknown>).voided_at =
      "2026-08-25T00:00:00.000Z";
    const inputs = await gatherVatQuarterInputs(makeDb(tables), ORG, Q1_START, Q1_END);
    expect(inputs.reverseCharge.vat).toBe(0);
  });
});
