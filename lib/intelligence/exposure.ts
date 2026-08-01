import { round2 } from "@/lib/money";
import {
  retentionClaimableNow,
  type RetentionRegisterTotals,
} from "@/lib/commercial/retention-register";
import type { AgeingTotals } from "@/lib/commercial/ageing";
import { labelled, type LabelledMetric } from "./provenance";

/**
 * RETENTION EXPOSURE + AGED-DEBT BANDING — surfacing, not derivation. PURE.
 *
 * This module computes NOTHING new about money. Both inputs are the TOTALS
 * objects of existing authorities:
 *
 *   retention  `buildRetentionRegister(...).totals` — the register whose
 *              internal reconciliation (Σ remaining === Σ held) is already
 *              proved in __tests__/commercial/retention-register.test.ts.
 *              "Claimable now" is `retentionClaimableNow`, imported, not
 *              re-summed.
 *   aged debt  `buildAgeingLedger(...).totals` — the bucketer that is
 *              structurally unable to re-derive a balance (its own header),
 *              fed by `composeAgedDebtors` which composes `invoiceRemaining`
 *              and `invoiceDaysOverdue`.
 *
 * The only arithmetic below is one addition (`held + awaiting_completion`),
 * and it is a REGROUPING of the register's own per-state partition, not a new
 * money figure: "exposure" is defined as retention withheld that is NOT YET
 * claimable — the dated-future money plus the money with no completion date
 * to be owed from. Overdue and due money is CLAIMABLE, which is the opposite
 * of exposed-and-waiting, so it is reported separately as the number the
 * meeting is actually about.
 *
 * KIND: DERIVED throughout — every figure is the exact output of a ledger
 * authority, restated with its own label. No thresholds, no judgements.
 */

// ---------------------------------------------------------------------------
// Retention exposure
// ---------------------------------------------------------------------------

export type RetentionExposure = {
  /** Σ retention withheld and not yet released (the register's `held`). */
  heldTotal: number;
  /**
   * Held money NOT yet claimable: future-dated (`held`) plus undated
   * (`awaiting_completion`). The exposure — money of yours other people hold
   * with no present entitlement to demand it back.
   */
  notYetDue: number;
  /** Of `notYetDue`, the part with no practical-completion date anywhere. */
  awaitingCompletion: number;
  /** Overdue + due — claimable today (retentionClaimableNow). */
  claimableNow: number;
  /** Jobs currently holding retention. */
  jobsHolding: number;
  /** Jobs with at least one overdue release. */
  jobsOverdue: number;
};

export function computeRetentionExposure(
  totals: RetentionRegisterTotals,
): RetentionExposure {
  return {
    heldTotal: totals.held,
    notYetDue: round2(
      totals.outstandingByState.held + totals.outstandingByState.awaiting_completion,
    ),
    awaitingCompletion: totals.outstandingByState.awaiting_completion,
    claimableNow: retentionClaimableNow(totals),
    jobsHolding: totals.jobsHoldingCount,
    jobsOverdue: totals.jobsOverdueCount,
  };
}

export function retentionExposureMetric(
  e: RetentionExposure,
): LabelledMetric<RetentionExposure> {
  return labelled(e, {
    kind: "derived",
    basis:
      "The retention register's own per-moiety figures, regrouped: exposure is retention " +
      "withheld from you that is not yet claimable — future-dated releases plus jobs with no " +
      "practical-completion date recorded anywhere. Money already overdue or due is shown " +
      "separately as claimable now. Nothing is recalculated; the register's reconciliation " +
      "(withheld − released = held) is proved at source.",
    computedFrom: [{ label: "Retention register", href: "/reports/retention" }],
  });
}

// ---------------------------------------------------------------------------
// Aged-debt banding
// ---------------------------------------------------------------------------

export type AgedDebtSummary = {
  /** Everything currently owed to you (the ledger's total). */
  total: number;
  /** Σ the four past-due buckets. */
  pastDue: number;
  /** The 90+ band — the debt most at risk of never arriving. */
  over90: number;
  /** The 61–90 band. */
  d61to90: number;
  /** Owed with NO due date — cannot be late, cannot be chased on a date. */
  undated: number;
  debtorCount: number;
  invoiceCount: number;
};

export function computeAgedDebtSummary(totals: AgeingTotals): AgedDebtSummary {
  return {
    total: totals.total,
    pastDue: totals.pastDue,
    over90: totals.buckets.d91_plus,
    d61to90: totals.buckets.d61_90,
    undated: totals.undated,
    debtorCount: totals.partyCount,
    invoiceCount: totals.itemCount,
  };
}

export function agedDebtMetric(s: AgedDebtSummary): LabelledMetric<AgedDebtSummary> {
  return labelled(s, {
    kind: "derived",
    basis:
      "The aged-debtors ledger's own bands, restated: outstanding balances per invoice come " +
      "from the payment ledger (never the status), lateness is measured from each invoice's " +
      "due date by the single overdue authority, and a debt is 'past due' only strictly after " +
      "its due date. Undated debt sits in Current and is also disclosed separately — it cannot " +
      "be late, and it cannot be chased on a date either.",
    computedFrom: [{ label: "Aged debtors", href: "/reports/ageing" }],
  });
}
