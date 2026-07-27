import { round2, toPounds } from "@/lib/money";

import { rateForStatus } from "./verification";
import { isOutcomeStatus, type CisStatus } from "./types";

/**
 * H2-CIS M3 — the CIS deduction basis and the domestic reverse charge.
 *
 * PURE. No Supabase, no server-only, no I/O. Imported by server actions, pages
 * and tests alike.
 *
 * Every rule below is traced to HMRC guidance in docs/cis-domain.md with the
 * source URL and the date it was retrieved. This module is the app-side TWIN of
 * the database engine in supabase/migrations/20261051000000_cis_deduction.sql.
 * The database is the CONTROL — it independently recomputes every figure and
 * refuses anything that disagrees, for every role including service_role. This
 * module exists so the operator sees the numbers before they commit to them, and
 * gets a sentence instead of a constraint name when something is wrong.
 *
 * ── THE ARITHMETIC (docs/cis-domain.md §2) ──────────────────────────────────
 *   CIS gross payment = bill NET (ex-VAT)  −  CITB levy
 *   deduction basis   = CIS gross payment  −  qualifying materials
 *   CIS deduction     = deduction basis × rate
 *
 * `bill total × rate` is WRONG and appears nowhere. VAT is NEVER in the basis
 * (CIS340 §3.12). The CITB levy comes off the gross before materials, because
 * CISR15110 removes it from the reported "gross amount of payment" itself.
 */

// ---------------------------------------------------------------------------
// VAT treatment
// ---------------------------------------------------------------------------

export const VAT_TREATMENTS = ["standard", "reverse_charge"] as const;

export type VatTreatment = (typeof VAT_TREATMENTS)[number];

export function isVatTreatment(v: unknown): v is VatTreatment {
  return typeof v === "string" && (VAT_TREATMENTS as readonly string[]).includes(v);
}

export const VAT_TREATMENT_LABELS: Record<VatTreatment, string> = {
  standard: "Normal VAT",
  reverse_charge: "Domestic reverse charge",
};

export const VAT_TREATMENT_DESCRIPTIONS: Record<VatTreatment, string> = {
  standard: "The subcontractor charges VAT and you pay it to them as usual.",
  reverse_charge:
    "The subcontractor charges no VAT. You account for the VAT yourself and recover it as input tax, so the invoice total is the net figure.",
};

/**
 * The statutory legend HMRC requires on a reverse-charge invoice.
 *
 * Verbatim from the VAT reverse charge technical guide (retrieved 27 July 2026):
 * "VAT Act 1994 Section 55A applies" / "S55A VATA 94 applies" / "Customer to pay
 * the VAT to HMRC". Any of the three is acceptable; we print the first with the
 * plain-English one alongside it.
 */
export const REVERSE_CHARGE_LEGEND = "Reverse charge: VAT Act 1994 Section 55A applies";
export const REVERSE_CHARGE_CUSTOMER_NOTE = "Customer to pay the VAT to HMRC";

/** Rates the reverse charge can be calculated at — the same domain as `finances.vat_rate`. */
export const REVERSE_CHARGE_RATES = [0, 5, 20] as const;

// ---------------------------------------------------------------------------
// Rate authority
// ---------------------------------------------------------------------------

export type RateAuthority =
  | { ok: true; rate: number; status: CisStatus }
  | { ok: false; reason: string; status: CisStatus | null };

/**
 * The ONLY place the app decides what rate applies. The client never supplies
 * one — it is read from the M1 verification state, and the database refuses any
 * allocation whose rate disagrees.
 *
 * Pre-outcome statuses are REFUSED rather than defaulted. HMRC applies the higher
 * rate where it cannot identify the subcontractor; "we have not asked yet" is not
 * that, and guessing either 20% or 30% files a return that is wrong. Refusing is
 * the conservative branch — docs/cis-domain.md §7.
 */
export function resolveCisRate(
  profile: { cis_status: CisStatus; deduction_rate: number | null } | null,
): RateAuthority {
  if (!profile) {
    return {
      ok: false,
      status: null,
      reason:
        "This supplier isn't set up as a CIS subcontractor. Record an ordinary supplier payment instead.",
    };
  }
  if (!isOutcomeStatus(profile.cis_status)) {
    return {
      ok: false,
      status: profile.cis_status,
      reason:
        "There's no HMRC verification for this subcontractor yet, so there's no authority to deduct. Verify them first.",
    };
  }
  // The stored rate is the authority; `rateForStatus` is the cross-check. If the
  // two ever disagree the row is corrupt (M1's CHECK makes that unreachable), and
  // trusting either one silently would be worse than stopping.
  const derived = rateForStatus(profile.cis_status);
  const stored = profile.deduction_rate;
  if (derived === null || stored === null || derived !== stored) {
    return {
      ok: false,
      status: profile.cis_status,
      reason:
        "This subcontractor's status and deduction rate disagree. Re-record their verification before paying them.",
    };
  }
  return { ok: true, rate: stored, status: profile.cis_status };
}

// ---------------------------------------------------------------------------
// The bill-level basis
// ---------------------------------------------------------------------------

export type BillCisDetails = {
  /** Materials, consumable stores, fuel (except travelling), plant hire, prefab. */
  materials_amount: number | string | null;
  citb_levy_amount: number | string | null;
  vat_treatment: VatTreatment;
  reverse_charge_vat_rate: number | string | null;
};

export type BillBasis = {
  /** finances.amount — NET, ex-VAT. THE cost figure. */
  net: number;
  /** finances.amount + vat_total — what the supplier is owed and a payment settles. */
  gross: number;
  /** The VAT the subcontractor actually charged (0 under the reverse charge). */
  vat: number;
  materials: number;
  citbLevy: number;
  /** HMRC's "gross amount of payment": net − CITB levy. Reported on the return. */
  cisGrossPayment: number;
  /** cisGrossPayment − materials. What the rate is applied to. */
  basis: number;
  vatTreatment: VatTreatment;
  /** The rate the CUSTOMER accounts for under the reverse charge, else null. */
  reverseChargeRate: number | null;
  /** Notional VAT the customer must account for. 0 under normal VAT. */
  reverseChargeVat: number;
};

/**
 * The whole-bill figures. `details` may be absent: a bill with no CIS record
 * claims no materials, so the entire net value is treated as labour. That is the
 * CONSERVATIVE default — it deducts MORE, never less, so a forgotten materials
 * figure cannot under-deduct and under-report to HMRC.
 */
export function computeBillBasis(
  bill: { amount: number | string | null; vat_total: number | string | null },
  details: BillCisDetails | null,
): BillBasis {
  const net = round2(toPounds(bill.amount));
  const vat = round2(toPounds(bill.vat_total));
  const gross = round2(net + vat);

  const materials = round2(Math.max(0, toPounds(details?.materials_amount)));
  const citbLevy = round2(Math.max(0, toPounds(details?.citb_levy_amount)));
  const vatTreatment: VatTreatment = details?.vat_treatment === "reverse_charge"
    ? "reverse_charge"
    : "standard";
  const reverseChargeRate =
    vatTreatment === "reverse_charge" ? round2(toPounds(details?.reverse_charge_vat_rate)) : null;

  const cisGrossPayment = round2(Math.max(0, net - citbLevy));
  const basis = round2(Math.max(0, cisGrossPayment - materials));

  // Apportioned on the NET value, not the basis: the reverse charge applies to
  // the WHOLE supply including materials (goods supplied with construction
  // services are a single supply), while the CIS basis excludes them. Two
  // independent axes — docs/cis-domain.md §6.4.
  const reverseChargeVat =
    reverseChargeRate !== null ? round2((net * reverseChargeRate) / 100) : 0;

  return {
    net, gross, vat, materials, citbLevy,
    cisGrossPayment, basis, vatTreatment, reverseChargeRate, reverseChargeVat,
  };
}

// ---------------------------------------------------------------------------
// Partial payments — the cumulative method
// ---------------------------------------------------------------------------

export type PriorSettlement = {
  /** Σ amount of LIVE (non-voided) allocations already against this bill. */
  allocated: number;
  /** Σ cis_basis already frozen on those allocations. */
  basis: number;
  /** Σ cis_deduction already frozen on those allocations. */
  deduction: number;
  /** Σ cis_reverse_charge_vat already frozen on those allocations. */
  reverseChargeVat: number;
};

export const NO_PRIOR: PriorSettlement = {
  allocated: 0, basis: 0, deduction: 0, reverseChargeVat: 0,
};

export type AllocationDeduction = {
  /** This allocation's INCREMENTAL share of the labour basis. */
  basis: number;
  /** This allocation's INCREMENTAL deduction. */
  deduction: number;
  /** This allocation's INCREMENTAL notional reverse-charge VAT. */
  reverseChargeVat: number;
  /** The cumulative figures this was derived from, for display and debugging. */
  cumulativeAllocated: number;
  cumulativeBasis: number;
  cumulativeDeduction: number;
};

/**
 * The deduction for ONE allocation of a payment against ONE bill.
 *
 * ── WHY CUMULATIVE AND NOT PER-PAYMENT ──────────────────────────────────────
 * The requirement is that the deductions across all payments of a bill sum to
 * EXACTLY the deduction a single full payment would have produced. A naive
 * per-payment `round2(share × rate)` drifts: a £100 bill with £33.33 labour at
 * 20% (true total £6.67) paid £50 twice gives £3.33 + £3.33 = £6.66 — a penny
 * short, and the subcontractor's payment & deduction statement stops reconciling.
 *
 * So nothing is apportioned per payment. Each allocation recomputes the
 * CUMULATIVE figure for everything settled so far and subtracts what has already
 * been frozen. The final allocation absorbs the whole rounding residue and the
 * total is exact (£3.33 + £3.34 = £6.67). See docs/cis-domain.md §9.
 *
 * The material allowance is baked into the BILL-LEVEL basis, so it is never
 * "applied" per payment and cannot be double-counted however the payments split.
 *
 * Only the CURRENT allocation is computed — priors are read, never rewritten —
 * so this is fully compatible with M2's write-once ledger. After a void, the
 * frozen figures on other live allocations may reflect a different split of the
 * pennies than a fresh calculation would choose. That is correct and intended:
 * those are historical facts that have been reported to HMRC. The invariant is
 * that the TOTAL is right, not that history is retrospectively re-apportioned —
 * which is also why the results are clamped at zero rather than allowed to go
 * negative to "correct" an earlier allocation.
 */
export function computeAllocationDeduction(input: {
  bill: BillBasis;
  rate: number;
  amount: number | string | null;
  prior?: PriorSettlement;
}): AllocationDeduction {
  const { bill, rate } = input;
  const prior = input.prior ?? NO_PRIOR;
  const amount = round2(Math.max(0, toPounds(input.amount)));

  if (bill.gross <= 0) {
    return {
      basis: 0, deduction: 0, reverseChargeVat: 0,
      cumulativeAllocated: 0, cumulativeBasis: 0, cumulativeDeduction: 0,
    };
  }

  // Never exceed the bill: the DB's CAP 2 refuses over-payment first, but a
  // ratio above 1 would over-deduct, so clamp rather than trust.
  const cumulative = Math.min(round2(prior.allocated + amount), bill.gross);
  const share = cumulative / bill.gross;

  const cumulativeBasis = round2(bill.basis * share);
  const cumulativeDeduction = round2((cumulativeBasis * rate) / 100);
  const cumulativeRcVat = round2((round2(bill.net * share) * (bill.reverseChargeRate ?? 0)) / 100);
  const priorRcVat = round2(
    (round2((bill.net * Math.min(prior.allocated, bill.gross)) / bill.gross) *
      (bill.reverseChargeRate ?? 0)) / 100,
  );

  return {
    basis: round2(Math.max(0, cumulativeBasis - prior.basis)),
    deduction: round2(Math.max(0, cumulativeDeduction - prior.deduction)),
    reverseChargeVat:
      bill.vatTreatment === "reverse_charge"
        ? round2(Math.max(0, cumulativeRcVat - priorRcVat))
        : 0,
    cumulativeAllocated: cumulative,
    cumulativeBasis,
    cumulativeDeduction,
  };
}

// ---------------------------------------------------------------------------
// Whole-payment preview
// ---------------------------------------------------------------------------

export type DraftCisLine = {
  financeId: string;
  amount: number | string | null;
  bill: BillBasis;
  prior?: PriorSettlement;
};

export type CisPaymentPreview = {
  /** Σ allocation amounts — what the payment settles, VAT included. */
  settled: number;
  /** Σ this payment's share of HMRC's "gross amount of payment" (net, ex-levy). */
  cisGrossPayment: number;
  /** Σ this payment's share of qualifying materials. */
  materials: number;
  citbLevy: number;
  /** Σ incremental basis. */
  basis: number;
  /** Σ incremental deduction — this becomes supplier_payments.cis_withheld. */
  deduction: number;
  /** Cash that will actually leave the bank. */
  cashOut: number;
  /** Σ notional reverse-charge VAT the CUSTOMER must account for. */
  reverseChargeVat: number;
  /** True when ANY line is under the reverse charge. */
  hasReverseCharge: boolean;
  lines: Array<AllocationDeduction & { financeId: string; amount: number }>;
};

/**
 * What the operator will be committing to, computed exactly as the database will.
 *
 * Note the materials and levy figures are this PAYMENT'S SHARE, not the whole
 * bill's — so the preview reconciles as
 * `cisGrossPayment − materials = basis` for the payment being made, which is the
 * only version of those numbers that makes sense on a part payment.
 */
export function previewCisPayment(
  lines: DraftCisLine[],
  rate: number,
): CisPaymentPreview {
  let settled = 0;
  let cisGrossPayment = 0;
  let materials = 0;
  let citbLevy = 0;
  let basis = 0;
  let deduction = 0;
  let reverseChargeVat = 0;
  let hasReverseCharge = false;

  const out: CisPaymentPreview["lines"] = [];

  for (const line of lines) {
    const amount = round2(Math.max(0, toPounds(line.amount)));
    if (amount <= 0) continue;
    const prior = line.prior ?? NO_PRIOR;
    const result = computeAllocationDeduction({ bill: line.bill, rate, amount, prior });

    const share = line.bill.gross > 0 ? result.cumulativeAllocated / line.bill.gross : 0;
    const priorShare =
      line.bill.gross > 0 ? Math.min(prior.allocated, line.bill.gross) / line.bill.gross : 0;

    settled = round2(settled + amount);
    basis = round2(basis + result.basis);
    deduction = round2(deduction + result.deduction);
    reverseChargeVat = round2(reverseChargeVat + result.reverseChargeVat);
    materials = round2(
      materials + round2(line.bill.materials * share) - round2(line.bill.materials * priorShare),
    );
    citbLevy = round2(
      citbLevy + round2(line.bill.citbLevy * share) - round2(line.bill.citbLevy * priorShare),
    );
    cisGrossPayment = round2(
      cisGrossPayment +
        round2(line.bill.cisGrossPayment * share) -
        round2(line.bill.cisGrossPayment * priorShare),
    );
    if (line.bill.vatTreatment === "reverse_charge") hasReverseCharge = true;

    out.push({ ...result, financeId: line.financeId, amount });
  }

  return {
    settled,
    cisGrossPayment,
    materials,
    citbLevy,
    basis,
    deduction,
    cashOut: round2(settled - deduction),
    reverseChargeVat,
    hasReverseCharge,
    lines: out,
  };
}

// ---------------------------------------------------------------------------
// Validation (a courtesy — the DB is the control)
// ---------------------------------------------------------------------------

export type CisDraftValidation = {
  ok: boolean;
  errors: string[];
  preview: CisPaymentPreview;
};

/**
 * Check a proposed CIS payment BEFORE it reaches the database, so the operator
 * gets a sentence instead of a constraint name.
 *
 * Every rule here is independently enforced by a CHECK, a composite FK or a
 * SECURITY DEFINER trigger in 20261051000000, and those hold for direct
 * PostgREST callers that never run this code.
 */
export function validateCisPaymentDraft(input: {
  lines: DraftCisLine[];
  rate: number;
  /** Remaining balance per bill, from computeBillSettlements. */
  outstandingByBill: Map<string, number>;
}): CisDraftValidation {
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const line of input.lines) {
    const amount = round2(toPounds(line.amount));
    if (amount <= 0) continue;
    if (seen.has(line.financeId)) {
      errors.push("The same bill is listed twice — combine it into one line.");
      continue;
    }
    seen.add(line.financeId);

    const remaining = input.outstandingByBill.get(line.financeId);
    if (remaining === undefined) {
      errors.push("One of the bills isn't an open bill for this supplier.");
      continue;
    }
    if (amount > round2(remaining + 0.005)) {
      errors.push(
        `You can't pay ${amount.toFixed(2)} against a bill with ${remaining.toFixed(2)} outstanding.`,
      );
    }
    if (round2(line.bill.materials + line.bill.citbLevy) > line.bill.net) {
      errors.push(
        "A bill's materials and CITB levy add up to more than its net value — check the split.",
      );
    }
    if (line.bill.vatTreatment === "reverse_charge" && line.bill.vat > 0) {
      errors.push(
        "A reverse-charge bill can't also charge VAT. Set the bill's VAT rate to 0 and record the reverse-charge rate on the CIS details.",
      );
    }
  }

  if (seen.size === 0) {
    errors.push("Choose at least one bill — a CIS deduction needs a bill to work from.");
  }
  if (!(input.rate >= 0 && input.rate <= 100)) {
    errors.push("There's no valid deduction rate for this subcontractor.");
  }

  const preview = previewCisPayment(input.lines, input.rate);
  const unique = [...new Set(errors)];
  return { ok: unique.length === 0, errors: unique, preview };
}
