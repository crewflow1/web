import { round2, toPounds } from "@/lib/money";
import type { CommercialCashPosition } from "@/lib/commercial/cash";

/**
 * The ONE reconciled "Get Paid" view for a job. COMPOSES the existing
 * authorities — it never re-sums invoices or payments:
 *   - cash figures come from lib/commercial/cash (the cash authority, GROSS);
 *   - retentionHeld comes from lib/retentions (ex-VAT);
 *   - scheduled figures come from the billing plan (NET / ex-VAT).
 *
 * Two clearly-separated axes so VAT bases are never mixed by accident:
 *   NET planning axis  — contractNet · scheduledNet · unscheduledNet (ex-VAT)
 *   GROSS cash axis    — billed · received · outstanding · overdue · stillToBill
 *
 * The one cross-axis figure is deliberate and correct: `collectableNow =
 * outstanding − retentionHeld`. Outstanding is GROSS and retention is ex-VAT, but
 * VAT is never retained, so subtracting the ex-VAT held amount from gross
 * outstanding yields the true chase-now debtor (fixes the known defect where
 * withheld retention showed as ordinary overdue debt).
 */
export interface GetPaidSummary {
  // NET planning axis (ex-VAT) — the billing plan.
  contractNet: number;
  scheduledNet: number;
  unscheduledNet: number;
  hasPlan: boolean;
  // GROSS cash axis — lib/commercial/cash (authority).
  billed: number;
  received: number;
  outstanding: number;
  overdue: number;
  stillToBill: number;
  // Retention (ex-VAT) — lib/retentions (authority).
  retentionHeld: number;
  // Reconciled: the true chase-now debtor with withheld retention removed.
  collectableNow: number;
}

export function computeGetPaidSummary(input: {
  cash: CommercialCashPosition;
  retentionHeld: number;
  /** Ex-VAT contract basis from the plan (0 when there's no plan). */
  contractNet: number;
  /** Ex-VAT Σ of stage amounts (0 when there's no plan). */
  scheduledNet: number;
  hasPlan: boolean;
}): GetPaidSummary {
  const contractNet = round2(toPounds(input.contractNet));
  const scheduledNet = round2(toPounds(input.scheduledNet));
  const outstanding = round2(toPounds(input.cash.outstanding));
  const retentionHeld = round2(Math.max(0, toPounds(input.retentionHeld)));

  return {
    contractNet,
    scheduledNet,
    unscheduledNet: contractNet > 0 ? round2(Math.max(0, contractNet - scheduledNet)) : 0,
    hasPlan: input.hasPlan,
    billed: round2(toPounds(input.cash.billed)),
    received: round2(toPounds(input.cash.received)),
    outstanding,
    overdue: round2(toPounds(input.cash.overdue)),
    stillToBill: round2(toPounds(input.cash.stillToBill)),
    retentionHeld,
    collectableNow: round2(Math.max(0, outstanding - retentionHeld)),
  };
}
