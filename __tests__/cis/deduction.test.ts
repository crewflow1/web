import { describe, expect, it } from "vitest";

import {
  NO_PRIOR,
  REVERSE_CHARGE_LEGEND,
  REVERSE_CHARGE_RATES,
  VAT_TREATMENTS,
  computeAllocationDeduction,
  computeBillBasis,
  isVatTreatment,
  previewCisPayment,
  resolveCisRate,
  validateCisPaymentDraft,
  type BillBasis,
  type PriorSettlement,
} from "@/lib/cis/deduction";
import { round2 } from "@/lib/money";

/**
 * H2-CIS M3 — the deduction engine, penny by penny.
 *
 * Tax rules verified against HMRC guidance on 27 July 2026 and recorded in
 * docs/cis-domain.md. The arithmetic under test:
 *
 *   CIS gross payment = bill NET (ex-VAT)  −  CITB levy      (CISR15110)
 *   deduction basis   = CIS gross payment  −  materials      (CIS340 3.12)
 *   CIS deduction     = deduction basis × rate               (20/30/0)
 *
 * `bill total × rate` is WRONG and every test here would fail if it crept in.
 */

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function bill(opts: {
  net: number;
  vatRate?: 0 | 5 | 20;
  materials?: number;
  citb?: number;
  reverseCharge?: 0 | 5 | 20 | null;
}): BillBasis {
  const vat = round2((opts.net * (opts.vatRate ?? 0)) / 100);
  return computeBillBasis(
    { amount: opts.net, vat_total: vat },
    {
      materials_amount: opts.materials ?? 0,
      citb_levy_amount: opts.citb ?? 0,
      vat_treatment: opts.reverseCharge != null ? "reverse_charge" : "standard",
      reverse_charge_vat_rate: opts.reverseCharge ?? null,
    },
  );
}

/**
 * Replay a bill paid in a sequence of instalments through the CUMULATIVE method,
 * exactly as the database does: each step reads the frozen priors and computes
 * only its own increment.
 */
function payInInstalments(b: BillBasis, rate: number, amounts: number[]) {
  let prior: PriorSettlement = { ...NO_PRIOR };
  const steps = amounts.map((amount) => {
    const r = computeAllocationDeduction({ bill: b, rate, amount, prior });
    prior = {
      allocated: round2(prior.allocated + amount),
      basis: round2(prior.basis + r.basis),
      deduction: round2(prior.deduction + r.deduction),
      reverseChargeVat: round2(prior.reverseChargeVat + r.reverseChargeVat),
    };
    return r;
  });
  return { steps, total: prior };
}

// ---------------------------------------------------------------------------
// Rate authority
// ---------------------------------------------------------------------------

describe("resolveCisRate — the rate is derived, never supplied", () => {
  it("gives 0 for gross payment status", () => {
    const r = resolveCisRate({ cis_status: "gross", deduction_rate: 0 });
    expect(r).toEqual({ ok: true, rate: 0, status: "gross" });
  });

  it("gives 20 for a registered subcontractor", () => {
    expect(resolveCisRate({ cis_status: "standard_20", deduction_rate: 20 })).toMatchObject({
      ok: true,
      rate: 20,
    });
  });

  it("gives 30 for an unregistered subcontractor", () => {
    expect(resolveCisRate({ cis_status: "higher_30", deduction_rate: 30 })).toMatchObject({
      ok: true,
      rate: 30,
    });
  });

  it("gives 30 for an HMRC 'unmatched' result", () => {
    // HMRC: the higher rate applies where the subcontractor cannot be matched.
    expect(resolveCisRate({ cis_status: "failed", deduction_rate: 30 })).toMatchObject({
      ok: true,
      rate: 30,
    });
  });

  it("REFUSES a pre-outcome status rather than defaulting to 20 or 30", () => {
    // The conservative branch. Guessing either way files a wrong return.
    for (const status of ["unverified", "verification_required"] as const) {
      const r = resolveCisRate({ cis_status: status, deduction_rate: null });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/verif/i);
    }
  });

  it("REFUSES a supplier with no CIS profile at all", () => {
    const r = resolveCisRate(null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/ordinary supplier payment/i);
  });

  it("REFUSES a status and rate that disagree, rather than trusting either", () => {
    // Unreachable through M1's CHECK, but a corrupt row must stop the engine
    // rather than silently pick a number.
    const r = resolveCisRate({ cis_status: "standard_20", deduction_rate: 30 });
    expect(r.ok).toBe(false);
  });

  // ── STALE VERIFICATION ────────────────────────────────────────────────────
  // A verification is valid for its tax year plus the two following (verified
  // 2026-06-01 → good through 2029-04-05). Once lapsed the old rate has NO
  // authority — refuse rather than under-deduct if HMRC has since moved them up.
  it("still gives the rate when asOf is omitted (historical read, no freshness judgement)", () => {
    // Back-compat: existing callers that pass only status+rate are unaffected.
    const r = resolveCisRate({
      cis_status: "standard_20",
      deduction_rate: 20,
      verified_at: "2000-01-01",
      verification_expires_at: "2003-04-05",
    });
    expect(r).toMatchObject({ ok: true, rate: 20 });
  });

  it("gives the rate for a payment ON the derived expiry date (valid THROUGH it)", () => {
    const r = resolveCisRate(
      { cis_status: "standard_20", deduction_rate: 20, verified_at: "2026-06-01" },
      "2029-04-05",
    );
    expect(r).toMatchObject({ ok: true, rate: 20 });
  });

  it("REFUSES a payment dated the day AFTER the derived expiry", () => {
    const r = resolveCisRate(
      { cis_status: "standard_20", deduction_rate: 20, verified_at: "2026-06-01" },
      "2029-04-06",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/expired|re-verify/i);
  });

  it("honours a stored expiry shorter than the HMRC default", () => {
    const profile = {
      cis_status: "higher_30" as const,
      deduction_rate: 30,
      verified_at: "2026-06-01",
      verification_expires_at: "2026-12-31",
    };
    expect(resolveCisRate(profile, "2026-12-31")).toMatchObject({ ok: true, rate: 30 });
    expect(resolveCisRate(profile, "2027-01-01").ok).toBe(false);
  });

  it("a fresh re-verification unblocks a previously expired subcontractor", () => {
    const stale = resolveCisRate(
      { cis_status: "standard_20", deduction_rate: 20, verified_at: "2020-01-01" },
      "2026-08-17",
    );
    expect(stale.ok).toBe(false);
    const fresh = resolveCisRate(
      { cis_status: "standard_20", deduction_rate: 20, verified_at: "2026-08-01" },
      "2026-08-17",
    );
    expect(fresh).toMatchObject({ ok: true, rate: 20 });
  });
});

// ---------------------------------------------------------------------------
// The basis
// ---------------------------------------------------------------------------

describe("computeBillBasis — what the rate is applied to", () => {
  it("excludes materials (CIS340 3.12)", () => {
    const b = bill({ net: 10_000, materials: 3_000 });
    expect(b.basis).toBe(7_000);
    expect(b.cisGrossPayment).toBe(10_000);
  });

  it("excludes VAT — VAT is NEVER in the basis", () => {
    const withVat = bill({ net: 10_000, vatRate: 20, materials: 3_000 });
    const withoutVat = bill({ net: 10_000, vatRate: 0, materials: 3_000 });
    expect(withVat.gross).toBe(12_000);
    expect(withVat.vat).toBe(2_000);
    // The basis is identical whether VAT is charged or not.
    expect(withVat.basis).toBe(7_000);
    expect(withVat.basis).toBe(withoutVat.basis);
  });

  it("takes the CITB levy off the GROSS PAYMENT, before materials (CISR15110)", () => {
    // HMRC's own worked example: £1,000 contract, £7 levy ⇒ £993 reported gross.
    const b = bill({ net: 1_000, citb: 7 });
    expect(b.cisGrossPayment).toBe(993);
    expect(b.basis).toBe(993);
  });

  it("applies the levy AND materials in the right order", () => {
    const b = bill({ net: 1_000, citb: 7, materials: 200 });
    expect(b.cisGrossPayment).toBe(993);
    expect(b.basis).toBe(793);
  });

  it("treats a bill with NO CIS details as all labour — the conservative default", () => {
    // Deducts MORE, never less, so a forgotten materials figure cannot
    // under-deduct and under-report to HMRC.
    const b = computeBillBasis({ amount: 4_000, vat_total: 0 }, null);
    expect(b.materials).toBe(0);
    expect(b.basis).toBe(4_000);
    expect(b.vatTreatment).toBe("standard");
  });

  it("never produces a negative basis", () => {
    const b = bill({ net: 100, materials: 500 });
    expect(b.basis).toBe(0);
    expect(b.cisGrossPayment).toBe(100);
  });

  it("is NOT bill-total × rate — the difference is the whole point", () => {
    const b = bill({ net: 10_000, vatRate: 20, materials: 3_000 });
    const correct = round2((b.basis * 20) / 100);
    const wrong = round2((b.gross * 20) / 100);
    expect(correct).toBe(1_400);
    expect(wrong).toBe(2_400);
    expect(correct).not.toBe(wrong);
  });
});

// ---------------------------------------------------------------------------
// Rates end to end
// ---------------------------------------------------------------------------

describe("the three HMRC rates", () => {
  const b = bill({ net: 10_000, materials: 3_000 });

  it("gross status deducts nothing", () => {
    expect(computeAllocationDeduction({ bill: b, rate: 0, amount: 10_000 }).deduction).toBe(0);
  });

  it("standard rate deducts 20% of labour", () => {
    expect(computeAllocationDeduction({ bill: b, rate: 20, amount: 10_000 }).deduction).toBe(1_400);
  });

  it("higher rate deducts 30% of labour", () => {
    expect(computeAllocationDeduction({ bill: b, rate: 30, amount: 10_000 }).deduction).toBe(2_100);
  });

  it("labour-only: the whole net value is the basis", () => {
    const labourOnly = bill({ net: 5_000 });
    expect(computeAllocationDeduction({ bill: labourOnly, rate: 20, amount: 5_000 }).deduction).toBe(
      1_000,
    );
  });

  it("materials-only: nothing to deduct from", () => {
    const materialsOnly = bill({ net: 5_000, materials: 5_000 });
    expect(computeAllocationDeduction({ bill: materialsOnly, rate: 30, amount: 5_000 }).deduction).toBe(
      0,
    );
  });

  it("with VAT: cash out is net + VAT − deduction", () => {
    const withVat = bill({ net: 10_000, vatRate: 20, materials: 3_000 });
    const r = computeAllocationDeduction({ bill: withVat, rate: 20, amount: withVat.gross });
    expect(r.deduction).toBe(1_400);
    expect(round2(withVat.gross - r.deduction)).toBe(10_600);
  });
});

// ---------------------------------------------------------------------------
// PARTIAL PAYMENTS — the highest-risk area
// ---------------------------------------------------------------------------

describe("partial payments — no drift, no double-deduction", () => {
  it("£10,000 paid £4,000 then £6,000 totals exactly the single-payment figure", () => {
    const b = bill({ net: 10_000, materials: 3_000 });
    const single = computeAllocationDeduction({ bill: b, rate: 20, amount: 10_000 });
    const split = payInInstalments(b, 20, [4_000, 6_000]);

    expect(split.steps[0]!.deduction).toBe(560); // 40% of 1,400
    expect(split.steps[1]!.deduction).toBe(840); // 60% of 1,400
    expect(split.total.deduction).toBe(single.deduction);
    expect(split.total.deduction).toBe(1_400);
  });

  it("beats the naive per-payment method on the classic drift case", () => {
    // £100 net, £66.67 materials ⇒ £33.33 labour, 20% ⇒ £6.666 → £6.67.
    const b = bill({ net: 100, materials: 66.67 });
    expect(b.basis).toBe(33.33);

    const naive = round2(round2((round2(b.basis * 0.5) * 20) / 100) * 2);
    expect(naive).toBe(6.66); // one penny short — the bug this design prevents

    const split = payInInstalments(b, 20, [50, 50]);
    expect(split.steps.map((s) => s.deduction)).toEqual([3.33, 3.34]);
    expect(split.total.deduction).toBe(6.67);
  });

  it("the material allowance is never applied twice", () => {
    // If materials were deducted per payment, each half would get the FULL
    // £3,000 allowance and the deduction would collapse.
    const b = bill({ net: 10_000, materials: 3_000 });
    const split = payInInstalments(b, 20, [5_000, 5_000]);
    expect(split.total.basis).toBe(7_000);
    expect(split.total.deduction).toBe(1_400);
    // The wrong answer, for contrast: (5000−3000)×20% × 2 = 800.
    expect(split.total.deduction).not.toBe(800);
  });

  it("stays exact across MANY awkward instalments", () => {
    const b = bill({ net: 1_000, materials: 333.33, citb: 1.11 });
    const single = computeAllocationDeduction({ bill: b, rate: 30, amount: 1_000 });
    const split = payInInstalments(b, 30, [
      0.01, 0.02, 0.03, 99.94, 100, 100, 100, 100, 100, 100, 100, 100, 99.99, 0.01,
    ]);
    expect(round2(split.total.allocated)).toBe(1_000);
    expect(split.total.deduction).toBe(single.deduction);
    expect(split.total.basis).toBe(b.basis);
  });

  it("handles 1p and 2p instalments without going negative", () => {
    const b = bill({ net: 0.03, materials: 0.01 });
    expect(b.basis).toBe(0.02);
    const split = payInInstalments(b, 20, [0.01, 0.01, 0.01]);
    for (const s of split.steps) expect(s.deduction).toBeGreaterThanOrEqual(0);
    expect(split.total.deduction).toBe(computeAllocationDeduction({ bill: b, rate: 20, amount: 0.03 }).deduction);
  });

  it("is exact for a large amount", () => {
    const b = bill({ net: 2_500_000, vatRate: 20, materials: 812_345.67 });
    const single = computeAllocationDeduction({ bill: b, rate: 30, amount: b.gross });
    const split = payInInstalments(b, 30, [b.gross / 3, b.gross / 3, round2(b.gross - 2 * round2(b.gross / 3))]);
    expect(split.total.deduction).toBe(single.deduction);
  });

  it("never lets the ratio exceed 1 even if an over-payment slipped through", () => {
    const b = bill({ net: 1_000, materials: 100 });
    const r = computeAllocationDeduction({
      bill: b,
      rate: 20,
      amount: 5_000, // absurd; the DB's CAP 2 refuses this first
      prior: NO_PRIOR,
    });
    expect(r.cumulativeAllocated).toBe(1_000);
    expect(r.deduction).toBe(180); // 900 × 20%, not 5,000 × 20%
  });

  it("clamps at zero rather than producing a negative correction after a void", () => {
    // Simulates the awkward case: the frozen priors sum to MORE than a fresh
    // cumulative calculation would give (possible after a void re-sequences the
    // live set). The next allocation must not "give money back".
    const b = bill({ net: 100 });
    const r = computeAllocationDeduction({
      bill: b,
      rate: 20,
      amount: 10,
      prior: { allocated: 50, basis: 60, deduction: 15, reverseChargeVat: 0 },
    });
    expect(r.basis).toBeGreaterThanOrEqual(0);
    expect(r.deduction).toBeGreaterThanOrEqual(0);
  });

  it("returns zeroes for a worthless bill instead of dividing by zero", () => {
    const b = computeBillBasis({ amount: 0, vat_total: 0 }, null);
    const r = computeAllocationDeduction({ bill: b, rate: 20, amount: 100 });
    expect(r).toMatchObject({ basis: 0, deduction: 0, reverseChargeVat: 0 });
  });
});

// ---------------------------------------------------------------------------
// Reverse charge
// ---------------------------------------------------------------------------

describe("domestic reverse charge — a treatment, not vat = 0", () => {
  it("preserves the net value, the VAT basis and the treatment", () => {
    const b = bill({ net: 5_000, materials: 1_000, reverseCharge: 20 });
    expect(b.net).toBe(5_000);
    expect(b.vat).toBe(0); // the subcontractor charges none
    expect(b.gross).toBe(5_000); // so the payable really is the net
    expect(b.vatTreatment).toBe("reverse_charge");
    expect(b.reverseChargeRate).toBe(20); // …but the rate is still a real fact
    expect(b.reverseChargeVat).toBe(1_000); // …and so is the amount
  });

  it("carries the statutory legend HMRC requires on the invoice", () => {
    expect(REVERSE_CHARGE_LEGEND).toMatch(/Section 55A/);
  });

  it("applies to the WHOLE supply including materials, while CIS excludes them", () => {
    // Two independent axes — HMRC treats goods supplied with construction
    // services as a single supply, but the CIS basis still drops materials.
    const b = bill({ net: 5_000, materials: 1_000, reverseCharge: 20 });
    expect(b.reverseChargeVat).toBe(1_000); // 20% of the FULL 5,000
    expect(b.basis).toBe(4_000); // materials still excluded
    const r = computeAllocationDeduction({ bill: b, rate: 20, amount: 5_000 });
    expect(r.deduction).toBe(800);
    expect(r.reverseChargeVat).toBe(1_000);
  });

  it("does not change the CIS deduction at all", () => {
    const normal = bill({ net: 5_000, materials: 1_000 });
    const rc = bill({ net: 5_000, materials: 1_000, reverseCharge: 20 });
    expect(computeAllocationDeduction({ bill: rc, rate: 20, amount: 5_000 }).deduction).toBe(
      computeAllocationDeduction({ bill: normal, rate: 20, amount: 5_000 }).deduction,
    );
  });

  it("apportions the notional VAT across part payments without drift", () => {
    const b = bill({ net: 1_000, materials: 333.33, reverseCharge: 5 });
    const split = payInInstalments(b, 20, [333.33, 333.33, 333.34]);
    expect(split.total.reverseChargeVat).toBe(b.reverseChargeVat);
    expect(split.total.reverseChargeVat).toBe(50);
  });

  it("reports zero notional VAT under normal treatment", () => {
    const b = bill({ net: 1_000 });
    expect(b.reverseChargeVat).toBe(0);
    expect(computeAllocationDeduction({ bill: b, rate: 20, amount: 1_000 }).reverseChargeVat).toBe(0);
  });

  it("supports every legal UK VAT rate and no others", () => {
    expect([...REVERSE_CHARGE_RATES]).toEqual([0, 5, 20]);
    expect(VAT_TREATMENTS).toEqual(["standard", "reverse_charge"]);
    expect(isVatTreatment("reverse_charge")).toBe(true);
    expect(isVatTreatment("exempt")).toBe(false);
    expect(isVatTreatment(20)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Whole-payment preview
// ---------------------------------------------------------------------------

describe("previewCisPayment — multiple bills on one payment", () => {
  it("sums each bill's own basis rather than averaging them", () => {
    const labour = bill({ net: 1_000 });
    const mixed = bill({ net: 2_000, materials: 1_500 });
    const p = previewCisPayment(
      [
        { financeId: "a", amount: 1_000, bill: labour },
        { financeId: "b", amount: 2_000, bill: mixed },
      ],
      20,
    );
    expect(p.settled).toBe(3_000);
    expect(p.basis).toBe(1_500); // 1,000 + 500
    expect(p.deduction).toBe(300);
    expect(p.materials).toBe(1_500);
    expect(p.cashOut).toBe(2_700);
  });

  it("reconciles: gross payment − materials = basis", () => {
    const p = previewCisPayment(
      [{ financeId: "a", amount: 1_000, bill: bill({ net: 1_000, materials: 300, citb: 7 }) }],
      20,
    );
    expect(round2(p.cisGrossPayment - p.materials)).toBe(p.basis);
    expect(p.citbLevy).toBe(7);
  });

  it("flags reverse charge when ANY line carries it", () => {
    const p = previewCisPayment(
      [
        { financeId: "a", amount: 100, bill: bill({ net: 100 }) },
        { financeId: "b", amount: 200, bill: bill({ net: 200, reverseCharge: 20 }) },
      ],
      20,
    );
    expect(p.hasReverseCharge).toBe(true);
    expect(p.reverseChargeVat).toBe(40);
  });

  it("ignores zero and negative lines", () => {
    const p = previewCisPayment(
      [
        { financeId: "a", amount: 0, bill: bill({ net: 100 }) },
        { financeId: "b", amount: -5, bill: bill({ net: 100 }) },
      ],
      20,
    );
    expect(p.settled).toBe(0);
    expect(p.lines).toHaveLength(0);
  });

  it("respects prior settlement per bill", () => {
    const b = bill({ net: 1_000, materials: 400 });
    const p = previewCisPayment(
      [
        {
          financeId: "a",
          amount: 500,
          bill: b,
          prior: { allocated: 500, basis: 300, deduction: 60, reverseChargeVat: 0 },
        },
      ],
      20,
    );
    expect(p.basis).toBe(300);
    expect(p.deduction).toBe(60);
    // Both halves together are the whole-bill figure.
    expect(round2(60 + 60)).toBe(round2((b.basis * 20) / 100));
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validateCisPaymentDraft", () => {
  const b = bill({ net: 1_000, materials: 200 });

  it("accepts a well-formed draft", () => {
    const v = validateCisPaymentDraft({
      lines: [{ financeId: "a", amount: 500, bill: b }],
      rate: 20,
      outstandingByBill: new Map([["a", 1_000]]),
    });
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it("refuses a line that exceeds the bill's outstanding balance", () => {
    const v = validateCisPaymentDraft({
      lines: [{ financeId: "a", amount: 900, bill: b }],
      rate: 20,
      outstandingByBill: new Map([["a", 400]]),
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/outstanding/i);
  });

  it("refuses a bill that isn't this supplier's", () => {
    const v = validateCisPaymentDraft({
      lines: [{ financeId: "other", amount: 100, bill: b }],
      rate: 20,
      outstandingByBill: new Map([["a", 1_000]]),
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/open bill/i);
  });

  it("refuses a duplicated bill line", () => {
    const v = validateCisPaymentDraft({
      lines: [
        { financeId: "a", amount: 100, bill: b },
        { financeId: "a", amount: 100, bill: b },
      ],
      rate: 20,
      outstandingByBill: new Map([["a", 1_000]]),
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/twice/i);
  });

  it("refuses a payment with no bills — there is no basis without one", () => {
    const v = validateCisPaymentDraft({ lines: [], rate: 20, outstandingByBill: new Map() });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/at least one bill/i);
  });

  it("refuses a reverse-charge bill that also charges VAT", () => {
    const contradiction = computeBillBasis(
      { amount: 1_000, vat_total: 200 },
      {
        materials_amount: 0,
        citb_levy_amount: 0,
        vat_treatment: "reverse_charge",
        reverse_charge_vat_rate: 20,
      },
    );
    const v = validateCisPaymentDraft({
      lines: [{ financeId: "a", amount: 100, bill: contradiction }],
      rate: 20,
      outstandingByBill: new Map([["a", 1_200]]),
    });
    expect(v.ok).toBe(false);
    expect(v.errors.join(" ")).toMatch(/reverse-charge bill can't also charge VAT/i);
  });

  it("refuses an out-of-range rate", () => {
    const v = validateCisPaymentDraft({
      lines: [{ financeId: "a", amount: 100, bill: b }],
      rate: 999,
      outstandingByBill: new Map([["a", 1_000]]),
    });
    expect(v.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The M2 invariant
// ---------------------------------------------------------------------------

describe("the load-bearing invariant: CIS does not reduce cost", () => {
  it("never derives a cost figure from the deduction", () => {
    const b = bill({ net: 10_000, vatRate: 20, materials: 3_000 });
    const r = computeAllocationDeduction({ bill: b, rate: 30, amount: b.gross });
    // The NET value — the cost — is untouched by a 30% deduction.
    expect(b.net).toBe(10_000);
    expect(r.deduction).toBe(2_100);
    // Cash out is lower; cost is not.
    expect(round2(b.gross - r.deduction)).toBe(9_900);
    expect(b.net).toBe(10_000);
  });

  it("produces the same cost figure at every rate", () => {
    for (const rate of [0, 20, 30]) {
      const b = bill({ net: 8_000, materials: 1_000 });
      computeAllocationDeduction({ bill: b, rate, amount: 8_000 });
      expect(b.net).toBe(8_000);
      expect(b.cisGrossPayment).toBe(8_000);
    }
  });
});
