import { isHmrcConnectable } from "./oauth";

import type { MonthlyReturnDataset } from "@/lib/cis/statements";

/**
 * HMRC CIS300 monthly return — the submission payload COMPOSER. DARK.
 *
 * Composes the CIS300 monthly-return body from CrewFlow's EXISTING CIS return
 * DATASET (lib/cis/statements.ts buildMonthlyReturnDataset, which folds the
 * frozen cis_payment_snapshots figures). It is PURE — no network, no I/O, no
 * `server-only` — and it computes NO deduction: every money figure comes from the
 * dataset, which itself never recomputes M3's frozen figures. There is one CIS
 * calculator in the product and this is not it.
 *
 * ── LEGAL BOUNDARY — COMPOSE, NEVER SUBMIT ──────────────────────────────────
 * This builds a payload; it does not send it. CrewFlow is not (yet) an HMRC-
 * recognised CIS filer, and recognition is a legal/commercial gate. The substrate
 * stops at "prepared/held": the composed payload is stored in hmrc_submissions
 * (status prepared|held — there is no filed state) and never transmitted. This
 * mirrors the existing CIS_NO_FILING_NOTICE posture in lib/cis/statements.ts.
 *
 * ── REFUSE WHEN DARK ────────────────────────────────────────────────────────
 * `composeCis300Return` REFUSES (returns { ok:false, reason:'not_configured' })
 * unless HMRC is connectable (two-switch). So while dark not even the payload is
 * built.
 *
 * ── THE DECLARATIONS ────────────────────────────────────────────────────────
 * A real CIS300 carries the contractor's declarations (employment status,
 * verification, inactivity, information-correct). NONE are asserted here on the
 * user's behalf: they default to `null`/false and must be set by a human at
 * submission (which this build never reaches). Inventing a declaration would be
 * a fabricated statutory statement.
 */

export type Cis300Contractor = {
  /** The contractor's Accounts Office reference. */
  aoReference?: string | null;
  /** The contractor's employer PAYE reference (district/reference). */
  employerPayeReference?: string | null;
  /** UTR of the contractor filing the return. */
  utr?: string | null;
  name?: string | null;
};

/** One subcontractor line, HMRC CIS300 field vocabulary. */
export type Cis300SubcontractorLine = {
  name: string;
  utr: string | null;
  /** HMRC's "verification number" — present only for higher-rate unmatched cases. */
  verificationNumber: string | null;
  /** HMRC "total payments made" — gross, ex-VAT, ex-CITB. */
  totalPayments: number;
  /** HMRC "cost of materials" that reduced the amount deducted from. */
  costOfMaterials: number;
  /** HMRC "total amount deducted". */
  totalDeducted: number;
};

/**
 * The contractor's statutory declarations. Each defaults to a NON-asserted value;
 * a human sets them at submission. `null` means "not declared".
 */
export type Cis300Declarations = {
  /** "Employment status" declaration — none of the workers are employees. */
  employmentStatus: boolean | null;
  /** "Verification" declaration — every unmatched subcontractor was verified. */
  verification: boolean | null;
  /** "Information correct" declaration. */
  informationCorrect: boolean | null;
  /** "Inactivity" request — mark the scheme inactive for future months. */
  inactivity: boolean | null;
};

export type Cis300Return = {
  /** UK tax year the tax month falls in, e.g. "2026-27". */
  taxYear: string;
  /** The tax-month window (HMRC's 6th→5th), ISO dates. */
  taxMonth: { from: string; to: string };
  contractor: Cis300Contractor;
  /** GOV.UK: a month with no payments is a REPORTABLE nil return. */
  nilReturn: boolean;
  subcontractors: Cis300SubcontractorLine[];
  declarations: Cis300Declarations;
};

export type ComposeCis300Input = {
  /** The output of lib/cis/statements.ts buildMonthlyReturnDataset. */
  dataset: MonthlyReturnDataset;
  /** Contractor identity (from the org's CIS settings). Optional; unset ⇒ null. */
  contractor?: Cis300Contractor;
};

export type ComposeCis300Result =
  | { ok: true; period: string; payload: Cis300Return }
  | { ok: false; reason: "not_configured" | "invalid"; message: string };

/**
 * Derive the UK tax year label "YYYY-YY" from a tax-month end date. HMRC's tax
 * year runs 6 April → 5 April, so a month ending on/after 6 April belongs to that
 * year; on/before 5 April it belongs to the previous one.
 */
function taxYearLabel(taxMonthEnd: string): string {
  const d = new Date(`${taxMonthEnd}T00:00:00Z`);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth(); // 0=Jan
  const day = d.getUTCDate();
  // Belongs to the year starting 6 April of `startYear`.
  const startYear = m > 3 || (m === 3 && day >= 6) ? y : y - 1;
  const end = (startYear + 1) % 100;
  return `${startYear}-${String(end).padStart(2, "0")}`;
}

/**
 * Compose the CIS300 monthly-return payload from the existing return dataset.
 * REFUSES when HMRC is not connectable (dark) or the dataset lacks a tax-month
 * end. Pure — builds a value, sends nothing. Declarations are never asserted.
 */
export function composeCis300Return(input: ComposeCis300Input): ComposeCis300Result {
  // DARK GUARD FIRST — do not even assemble a submission payload while dark.
  if (!isHmrcConnectable()) {
    return {
      ok: false,
      reason: "not_configured",
      message: "HMRC is not connected; no CIS300 return can be prepared.",
    };
  }

  const ds = input.dataset;
  const taxMonthEnd = typeof ds?.taxMonthEnd === "string" ? ds.taxMonthEnd.trim() : "";
  if (taxMonthEnd.length === 0) {
    return { ok: false, reason: "invalid", message: "The dataset has no tax-month end." };
  }

  const subcontractors: Cis300SubcontractorLine[] = ds.lines.map((l) => ({
    name: l.subcontractorName,
    utr: l.utrMasked,
    verificationNumber: l.verificationNumber,
    totalPayments: l.grossAmount,
    costOfMaterials: l.materialsAmount,
    totalDeducted: l.deductionAmount,
  }));

  return {
    ok: true,
    period: taxMonthEnd,
    payload: {
      taxYear: taxYearLabel(taxMonthEnd),
      taxMonth: { from: ds.taxMonthStart, to: taxMonthEnd },
      contractor: input.contractor ?? {
        aoReference: null,
        employerPayeReference: null,
        utr: null,
        name: null,
      },
      nilReturn: ds.isNil,
      subcontractors,
      // NEVER asserted on the user's behalf — a human declares these at
      // submission (which this build never reaches).
      declarations: {
        employmentStatus: null,
        verification: null,
        informationCorrect: null,
        inactivity: null,
      },
    },
  };
}
