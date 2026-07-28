import { round2, sumMoney, toPounds } from "@/lib/money";

import { cisReturnDueDate, cisStatementDueDate, cisTaxMonthLabel } from "./tax-month";
import type { CisStatus } from "./types";

/**
 * H2-CIS M4 — payment & deduction statements and the CIS300-shape monthly return
 * DATASET, as pure computation.
 *
 * PURE. No Supabase, no server-only, no I/O. Imported by server actions, pages,
 * the PDF renderer and tests alike.
 *
 * ── THIS MODULE COMPUTES NO DEDUCTION ───────────────────────────────────────
 * There is no rate here, no basis arithmetic, no materials apportionment and no
 * partial-payment maths. All of that is M3 (lib/cis/deduction.ts and
 * 20261051000000), which FROZE its results onto `cis_payment_snapshots` at
 * posting time. M4 only ever SUMS those frozen figures per tax month. If a
 * statement is wrong, the defect is in M3's engine and must be fixed there —
 * adding a second calculator here is how two answers to the same tax question
 * come into existence.
 *
 * ── NOTHING HERE FILES ANYTHING ─────────────────────────────────────────────
 * CrewFlow has no HMRC integration. The return dataset is figures for a human to
 * file through HMRC's own service or their filing software. `CIS_NO_FILING_NOTICE`
 * below is the wording every surface shows so that is never ambiguous.
 *
 * ── THE HMRC RULES, VERIFIED 28 JULY 2026 (docs/cis-domain.md §11) ───────────
 * Statement contents — CIS340 §3.15 / CISR12160, verbatim: "contractor's own
 * name and employer tax reference"; "end date of the tax month in which the
 * payment was made"; subcontractor name and UTR; "personal verification number
 * if the subcontractor could not be verified and a deduction at the higher rate
 * has been made"; "gross amount of the payments made"; "cost of any materials
 * that has reduced the amount"; "amount of the deduction".
 *
 * Note what is NOT on that list: the deduction RATE. A statement covers a whole
 * tax month and a subcontractor can be re-verified mid-month, so there may be no
 * single rate to state. We show it when it is unambiguous and say so when it is
 * not, rather than picking one or averaging two.
 */

// ---------------------------------------------------------------------------
// The filing boundary — stated once, shown everywhere
// ---------------------------------------------------------------------------

/**
 * The sentence every return surface must carry. CrewFlow assembles figures; it
 * does not transmit them, and a user must never be able to infer otherwise from
 * a status badge or a button label.
 */
export const CIS_NO_FILING_NOTICE =
  "CrewFlow does not file your CIS return with HMRC. These are the figures to file " +
  "yourself through HMRC's online service or your filing software.";

/** Return-dataset states. There is deliberately no "submitted" or "filed". */
export const CIS_RETURN_STATUSES = ["prepared", "exported"] as const;
export type CisReturnStatus = (typeof CIS_RETURN_STATUSES)[number];

export const CIS_RETURN_STATUS_LABELS: Record<CisReturnStatus, string> = {
  prepared: "Prepared",
  exported: "Exported",
};

export const CIS_RETURN_STATUS_DESCRIPTIONS: Record<CisReturnStatus, string> = {
  prepared: "The figures are assembled and frozen. Nothing has been sent to HMRC.",
  exported: "You downloaded these figures. That records what CrewFlow did — it does not mean the return has been filed.",
};

export const CIS_STATEMENT_STATUSES = ["issued", "superseded", "withdrawn"] as const;
export type CisStatementStatus = (typeof CIS_STATEMENT_STATUSES)[number];

export const CIS_STATEMENT_STATUS_LABELS: Record<CisStatementStatus, string> = {
  issued: "Issued",
  superseded: "Replaced",
  withdrawn: "Withdrawn",
};

// ---------------------------------------------------------------------------
// Verification numbers — the honesty rules
// ---------------------------------------------------------------------------

/**
 * The two M1 statuses that mean "HMRC could not match this subcontractor, so the
 * higher rate applies": `higher_30` (an unmatched verification result) and
 * `failed` (a recorded unmatched attempt). CISR12160 puts the personal
 * verification number on the statement in exactly this case and no other.
 */
export const HIGHER_RATE_STATUSES: readonly CisStatus[] = ["higher_30", "failed"];

export function isHigherRateStatus(status: CisStatus | null | undefined): boolean {
  return status != null && HIGHER_RATE_STATUSES.includes(status);
}

/**
 * Does HMRC require a verification number on this statement?
 *
 * CISR12160: only "if the subcontractor could not be verified and a deduction at
 * the higher rate has been applied". If ANY payment in the month was at the
 * higher rate, the statement needs the number — the conservative reading, since
 * a month mixing 20% and 30% still contains a higher-rate deduction.
 */
export function verificationNumberRequired(statuses: Array<CisStatus | null>): boolean {
  return statuses.some((s) => isHigherRateStatus(s));
}

export type VerificationNumberDisplay =
  | { kind: "not_required"; text: null }
  | { kind: "present"; text: string }
  | { kind: "missing"; text: string };

/**
 * What to PRINT for the verification number.
 *
 * The one rule that matters: when a number is required and we do not hold one,
 * this returns an explicit statement of absence. It NEVER returns a placeholder,
 * a derived value or an empty string dressed up as a number. A statement that
 * invents a verification number is a fabricated tax record, and a subcontractor
 * could rely on it.
 */
export function describeVerificationNumber(input: {
  required: boolean;
  number: string | null | undefined;
}): VerificationNumberDisplay {
  const trimmed = typeof input.number === "string" ? input.number.trim() : "";
  if (trimmed.length > 0) return { kind: "present", text: trimmed };
  if (!input.required) return { kind: "not_required", text: null };
  return {
    kind: "missing",
    text:
      "Not held — obtain the verification number from HMRC and issue a replacement statement.",
  };
}

// ---------------------------------------------------------------------------
// The frozen snapshot row this module reads
// ---------------------------------------------------------------------------

/**
 * One `cis_payment_snapshots` row joined to its payment. EVERY money field here
 * was frozen by M3 at posting time; this module never recomputes one.
 *
 * `cis_gross_payment` is HMRC's "gross amount of payment": NET of VAT (CIS340
 * §3.12) and NET of the CITB levy (CISR15110). It is deliberately NOT
 * `supplier_payments.gross_amount`, which is VAT-inclusive cash — reporting that
 * figure would overstate every VAT-registered subcontractor's gross by the VAT.
 */
export type CisPaymentSnapshotRow = {
  payment_id: string;
  supplier_id: string;
  paid_at: string;
  voided_at?: string | null;
  cis_status: CisStatus;
  deduction_rate: number | string;
  verification_reference: string | null;
  legal_name: string;
  utr_masked: string | null;
  cis_gross_payment: number | string;
  materials_total: number | string;
  cis_deduction: number | string;
  tax_month_start: string;
  tax_month_end: string;
};

/** Live = not voided. A voided payment leaves the statement population. */
export function isLiveSnapshot(row: CisPaymentSnapshotRow): boolean {
  return row.voided_at == null;
}

// ---------------------------------------------------------------------------
// Rate provenance
// ---------------------------------------------------------------------------

export type RateProvenance =
  | { uniform: true; rate: number; status: CisStatus }
  | { uniform: false; rate: null; status: null };

/**
 * A statement covers a whole tax month, and a subcontractor re-verified mid-month
 * can have two payments at two rates inside it. HMRC requires ONE entry per
 * subcontractor per month and does not require the rate on the statement at all,
 * so the honest options are "state the rate" (when there is one) or "say it
 * varied" — never "pick one" and never "average them".
 */
export function resolveRateProvenance(
  rows: Array<{ deduction_rate: number | string; cis_status: CisStatus }>,
): RateProvenance {
  const rates = new Set(rows.map((r) => round2(toPounds(r.deduction_rate))));
  const statuses = new Set(rows.map((r) => r.cis_status));
  if (rates.size === 1 && statuses.size === 1) {
    return {
      uniform: true,
      rate: [...rates][0]!,
      status: [...statuses][0]!,
    };
  }
  return { uniform: false, rate: null, status: null };
}

// ---------------------------------------------------------------------------
// The statement
// ---------------------------------------------------------------------------

export type ContractorIdentity = {
  legal_name: string;
  employer_paye_reference: string;
  accounts_office_reference?: string | null;
};

export type StatementSummary = {
  taxMonthStart: string;
  taxMonthEnd: string;
  taxMonthLabel: string;
  /** CISR12160: within 14 days of the tax month end. */
  dueOn: string;
  subcontractorName: string;
  utrMasked: string | null;
  verificationNumber: string | null;
  verificationNumberRequired: boolean;
  /** HMRC's "gross amount of the payments made" — ex-VAT, ex-CITB levy. */
  grossAmount: number;
  /** "cost of any materials that has reduced the amount". */
  materialsAmount: number;
  deductionAmount: number;
  paymentCount: number;
  rate: RateProvenance;
  /**
   * CIS340 §3.15 compels a statement only where a deduction was made. For a
   * gross-paid subcontractor it is "good practice ... but there is no obligation
   * to do so", so the document says which it is rather than implying the former.
   */
  isStatutory: boolean;
  payments: Array<{
    paymentId: string;
    paidOn: string;
    gross: number;
    materials: number;
    deduction: number;
    rate: number;
    status: CisStatus;
  }>;
};

/**
 * Summarise one subcontractor's live payments in one tax month into the
 * statement HMRC requires.
 *
 * Rows MUST already be filtered to a single (org, supplier, tax month); this is
 * a pure fold and does no filtering of its own beyond dropping voided rows,
 * because a function that quietly re-scopes its input hides the caller's bugs.
 *
 * Returns null for an empty month — a statement is only required for a tax month
 * in which a payment was actually made.
 */
export function summariseStatement(
  rows: CisPaymentSnapshotRow[],
  options: { taxMonthEnd?: string } = {},
): StatementSummary | null {
  const live = rows.filter(isLiveSnapshot);
  if (live.length === 0) return null;

  const taxMonthEnd = options.taxMonthEnd ?? live[0]!.tax_month_end;
  const taxMonthStart = live[0]!.tax_month_start;

  // Latest payment wins for the identity fields: it is the most recent record of
  // who this subcontractor was at the time they were paid. Sorted explicitly so
  // the result does not depend on the caller's query order.
  const byRecency = [...live].sort(
    (a, b) => (a.paid_at < b.paid_at ? 1 : a.paid_at > b.paid_at ? -1 : a.payment_id < b.payment_id ? 1 : -1),
  );
  const latest = byRecency[0]!;

  const grossAmount = sumMoney(live.map((r) => r.cis_gross_payment));
  const materialsAmount = sumMoney(live.map((r) => r.materials_total));
  const deductionAmount = sumMoney(live.map((r) => r.cis_deduction));

  const required = verificationNumberRequired(live.map((r) => r.cis_status));
  // Taken only from a HIGHER-RATE payment's frozen snapshot — that is the case
  // the number belongs to. Never borrowed from a standard-rate payment.
  const verificationNumber =
    byRecency.find((r) => isHigherRateStatus(r.cis_status) && (r.verification_reference ?? "").trim())
      ?.verification_reference?.trim() ?? null;

  return {
    taxMonthStart,
    taxMonthEnd,
    taxMonthLabel: cisTaxMonthLabel(taxMonthEnd) ?? taxMonthEnd,
    dueOn: cisStatementDueDate(taxMonthEnd) ?? taxMonthEnd,
    subcontractorName: latest.legal_name,
    utrMasked: latest.utr_masked,
    verificationNumber,
    verificationNumberRequired: required,
    grossAmount,
    materialsAmount,
    deductionAmount,
    paymentCount: live.length,
    rate: resolveRateProvenance(live),
    isStatutory: deductionAmount > 0,
    payments: byRecency
      .slice()
      .reverse()
      .map((r) => ({
        paymentId: r.payment_id,
        paidOn: r.paid_at,
        gross: round2(toPounds(r.cis_gross_payment)),
        materials: round2(toPounds(r.materials_total)),
        deduction: round2(toPounds(r.cis_deduction)),
        rate: round2(toPounds(r.deduction_rate)),
        status: r.cis_status,
      })),
  };
}

// ---------------------------------------------------------------------------
// The monthly return dataset (CIS300 shape) — DATA ONLY
// ---------------------------------------------------------------------------

export type MonthlyReturnLine = {
  supplierId: string;
  subcontractorName: string;
  utrMasked: string | null;
  verificationNumber: string | null;
  verificationNumberRequired: boolean;
  rate: RateProvenance;
  grossAmount: number;
  materialsAmount: number;
  deductionAmount: number;
  paymentCount: number;
};

export type MonthlyReturnDataset = {
  taxMonthStart: string;
  taxMonthEnd: string;
  taxMonthLabel: string;
  /** GOV.UK: the 19th of the month following the tax month. */
  dueOn: string;
  /**
   * A month with no payments is REPORTABLE — GOV.UK requires "a return showing
   * your payments were 0 (known as a 'nil return')". So this is a real dataset
   * with `isNil` true, never an absent one.
   */
  isNil: boolean;
  subcontractorCount: number;
  paymentCount: number;
  totalGross: number;
  totalMaterials: number;
  totalDeduction: number;
  lines: MonthlyReturnLine[];
};

/**
 * Build the dataset a CIS300 return would need for one org and one tax month.
 *
 * ONE LINE PER SUBCONTRACTOR, per HMRC: where a subcontractor's tax treatment
 * changed mid-month "you should only make one entry for that subcontractor
 * showing the total payments and deductions made".
 *
 * Subcontractors paid GROSS (0%) are included: the return reports payments made
 * to all subcontractors, whether paid gross or under deduction. That is why the
 * return's population is wider than the set of subcontractors owed a statement.
 *
 * NOTHING IS FILED BY CALLING THIS. It returns a value.
 */
export function buildMonthlyReturnDataset(
  rows: CisPaymentSnapshotRow[],
  taxMonthEnd: string,
): MonthlyReturnDataset {
  const live = rows.filter(isLiveSnapshot).filter((r) => r.tax_month_end === taxMonthEnd);

  const bySupplier = new Map<string, CisPaymentSnapshotRow[]>();
  for (const row of live) {
    const list = bySupplier.get(row.supplier_id);
    if (list) list.push(row);
    else bySupplier.set(row.supplier_id, [row]);
  }

  const lines: MonthlyReturnLine[] = [...bySupplier.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([supplierId, group]) => {
      const summary = summariseStatement(group, { taxMonthEnd })!;
      return {
        supplierId,
        subcontractorName: summary.subcontractorName,
        utrMasked: summary.utrMasked,
        verificationNumber: summary.verificationNumber,
        verificationNumberRequired: summary.verificationNumberRequired,
        rate: summary.rate,
        grossAmount: summary.grossAmount,
        materialsAmount: summary.materialsAmount,
        deductionAmount: summary.deductionAmount,
        paymentCount: summary.paymentCount,
      };
    });

  const start = live[0]?.tax_month_start ?? "";
  return {
    taxMonthStart: start,
    taxMonthEnd,
    taxMonthLabel: cisTaxMonthLabel(taxMonthEnd) ?? taxMonthEnd,
    dueOn: cisReturnDueDate(taxMonthEnd) ?? taxMonthEnd,
    isNil: lines.length === 0,
    subcontractorCount: lines.length,
    paymentCount: lines.reduce((n, l) => n + l.paymentCount, 0),
    totalGross: sumMoney(lines.map((l) => l.grossAmount)),
    totalMaterials: sumMoney(lines.map((l) => l.materialsAmount)),
    totalDeduction: sumMoney(lines.map((l) => l.deductionAmount)),
    lines,
  };
}

// ---------------------------------------------------------------------------
// Staleness — a statement vs the ledger it came from
// ---------------------------------------------------------------------------

export type StatementFreshness =
  | { fresh: true; reason: null }
  | { fresh: false; reason: string };

/**
 * Compare a statement's stored `ledger_fingerprint` with the fingerprint of the
 * ledger TODAY (from `public.cis_statement_ledger_fingerprint`).
 *
 * This is how a voided payment surfaces. M2 corrects a payment by voiding it and
 * recording a replacement, so a statement issued in good faith can end up
 * covering a payment that no longer exists. The statement itself is immutable
 * and is NOT rewritten — instead the divergence is detected and the operator is
 * told to issue a replacement, which supersedes the original rather than
 * altering it. The subcontractor already holds the first document; silently
 * changing our copy of it would be the dishonest option.
 */
export function assessStatementFreshness(input: {
  storedFingerprint: string;
  currentFingerprint: string;
  status: CisStatementStatus;
}): StatementFreshness {
  if (input.status !== "issued") return { fresh: true, reason: null };
  if (input.storedFingerprint === input.currentFingerprint) return { fresh: true, reason: null };
  return {
    fresh: false,
    reason:
      "The payments this statement covers have changed since it was issued — most likely one was voided. " +
      "Issue a replacement statement, which supersedes this one.",
  };
}

/** Days until (positive) or past (negative) a deadline, from a given date. */
export function daysUntil(deadlineIso: string, todayIso: string): number | null {
  const d = Date.parse(`${deadlineIso}T00:00:00Z`);
  const t = Date.parse(`${todayIso}T00:00:00Z`);
  if (!Number.isFinite(d) || !Number.isFinite(t)) return null;
  return Math.round((d - t) / 86_400_000);
}
