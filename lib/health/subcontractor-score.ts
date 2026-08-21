import {
  MIN_RATED_SAMPLE,
  isRated,
  ratio,
  type Ratio,
  type SupplierPerformance,
} from "@/lib/suppliers/performance";
import {
  SUPPLIER_OVERBILL_FLAG_PCT,
  SUPPLIER_SLOW_SETTLEMENT_PCT,
} from "@/lib/intelligence/supplier-performance";
import { labelled, type LabelledMetric } from "@/lib/intelligence/provenance";

/**
 * SUBCONTRACTOR SCORING — the supplier-performance measurement, scoped to CIS
 * subcontractors. PURE.
 *
 * ── COMPOSE, NEVER RE-DERIVE ────────────────────────────────────────────────
 * A CIS subcontractor IS a supplier with a `cis_subcontractors.supplier_id`
 * profile, so its conduct is already measured by the shipped supplier-performance
 * authority (lib/suppliers/performance.ts): on-time delivery, over-invoicing, and
 * how slowly WE settle its bills. This module ADDS NO MEASUREMENT — every input
 * is a `SupplierPerformance` the authority produced, already active-org scoped by
 * the read layer, and the only work here is to select the named columns and carry
 * their sample floors through. The read layer restricts the roster to CIS
 * subcontractors; this pure function never has to know which suppliers those are.
 *
 * ── NO COMPOSITE SCORE — THE SAME REFUSAL AS THE SUPPLIER LIB ───────────────
 * Despite the word "scoring", there is deliberately NO single blended number.
 * The three measures have DIFFERENT DENOMINATORS (deliveries, PO-linked bills,
 * settled bills) and one of them measures OUR behaviour, not the subcontractor's,
 * so no honest arithmetic combines them (lib/suppliers/performance.ts header
 * points 1 to 2). Each subcontractor is listed with its three named ratios, each
 * with its own sample size; the reader weighs them, because the reader is the one
 * who knows whether this trade is schedule-critical or margin-critical.
 *
 * ── SAMPLE FLOORS ARE PART OF EACH RATIO ────────────────────────────────────
 * A ratio below MIN_RATED_SAMPLE is WITHHELD (its `pct` is null) and the
 * subcontractor is COUNTED as withheld on that measure, never ranked on a rate
 * the data hasn't earned — "100% late from one delivery" cannot become a verdict.
 * The counts and the sample size are always carried, so the surface can show
 * "1 of 2 — too few to rate" and link through.
 *
 * ── KINDS ────────────────────────────────────────────────────────────────────
 *   · the per-subcontractor ratios + org roll-up: DERIVED — exact ratios over the
 *     shipped measurement, floored on the same convention.
 *   · the over-invoicing and slow-settlement FLAGS: HEURISTIC — thresholds
 *     somebody chose (reused verbatim from the supplier-performance rollup so the
 *     two surfaces can never disagree), stated in the basis.
 *
 * PURE: no I/O, no clock, whole-history like the measurement it composes.
 */

export const SUBCONTRACTOR_TOP_N = 8;

// ---------------------------------------------------------------------------
// Output rows
// ---------------------------------------------------------------------------

function subcontractorHref(supplierId: string): string {
  return `/suppliers/${supplierId}/performance`;
}

export type SubcontractorScoreRow = {
  supplierId: string;
  supplierName: string;
  href: string;
  /** POSTED deliveries — the lib's `delivery.deliveries`. */
  deliveries: number;
  /** Late / judgeable deliveries — the lib's own floored Ratio. */
  punctuality: Ratio;
  /** Over-billed / PO-linked-billed orders — the lib's own Ratio. */
  overBilled: Ratio;
  /** Σ excess on over-billed orders (£). */
  overBilledExcess: number;
  /** Fully-settled, dated bills — the lib's `settlement.n`. */
  settledBills: number;
  /** over60 / settled, floored by the same MIN_RATED_SAMPLE via ratio(). */
  slowSettlement: Ratio;
  /** True when nothing measurable exists yet (the lib's `empty`). */
  empty: boolean;
};

export type SubcontractorScoreboard = {
  /** Every CIS subcontractor the roster asked about. */
  subcontractorsConsidered: number;
  /** Those with ANY measurable history. */
  subcontractorsWithRecord: number;
  /** Those we have never traded with — shown apart, never as a clean sheet. */
  subcontractorsEmpty: number;

  /** Subcontractors with a record, worst delivery/over-billing first. */
  rows: SubcontractorScoreRow[];

  /** Withheld because the sample was too small on that measure. */
  withheldPunctuality: number;
  withheldOverBilling: number;
  withheldSettlement: number;

  /** Flagged for over-invoicing (heuristic), worst first. */
  overBillingFlags: SubcontractorScoreRow[];
  /** Flagged for slow settlement — OUR retention risk (heuristic), slowest first. */
  slowSettlementFlags: SubcontractorScoreRow[];
};

// ---------------------------------------------------------------------------
// The scoreboard
// ---------------------------------------------------------------------------

export function computeSubcontractorScoreboard(
  performances: SupplierPerformance[],
): SubcontractorScoreboard {
  const rowsAll: SubcontractorScoreRow[] = performances.map((p) => ({
    supplierId: p.supplierId,
    supplierName: p.supplierName,
    href: subcontractorHref(p.supplierId),
    deliveries: p.delivery.deliveries,
    punctuality: p.delivery.punctuality,
    overBilled: p.price.overBilled,
    overBilledExcess: p.price.overBilledExcess,
    settledBills: p.settlement.n,
    slowSettlement: ratio(p.settlement.bands.over60, p.settlement.n),
    empty: p.empty,
  }));

  const withRecord = rowsAll.filter((r) => !r.empty);

  // Withheld: has some observations on the measure but too few to rate.
  const withheldPunctuality = withRecord.filter(
    (r) => r.punctuality.n > 0 && !isRated(r.punctuality),
  ).length;
  const withheldOverBilling = withRecord.filter(
    (r) => r.overBilled.n > 0 && !isRated(r.overBilled),
  ).length;
  const withheldSettlement = withRecord.filter(
    (r) => r.slowSettlement.n > 0 && !isRated(r.slowSettlement),
  ).length;

  // Rank the listed rows: worst RATED punctuality first, then worst rated
  // over-billing, then more evidence, then a stable name/id tiebreak so the list
  // never flickers between renders. Unrated measures sink (they are not verdicts).
  const rankPct = (r: Ratio): number => (isRated(r) ? r.pct : -1);
  const rows = [...withRecord].sort(
    (a, b) =>
      rankPct(b.punctuality) - rankPct(a.punctuality) ||
      rankPct(b.overBilled) - rankPct(a.overBilled) ||
      b.deliveries - a.deliveries ||
      a.supplierName.localeCompare(b.supplierName) ||
      a.supplierId.localeCompare(b.supplierId),
  );

  const overBillingFlags = withRecord
    .filter((r) => isRated(r.overBilled) && r.overBilled.pct > SUPPLIER_OVERBILL_FLAG_PCT)
    .sort(
      (a, b) =>
        (b.overBilled.pct ?? 0) - (a.overBilled.pct ?? 0) ||
        b.overBilledExcess - a.overBilledExcess ||
        a.supplierName.localeCompare(b.supplierName) ||
        a.supplierId.localeCompare(b.supplierId),
    );

  const slowSettlementFlags = withRecord
    .filter((r) => isRated(r.slowSettlement) && r.slowSettlement.pct > SUPPLIER_SLOW_SETTLEMENT_PCT)
    .sort(
      (a, b) =>
        (b.slowSettlement.pct ?? 0) - (a.slowSettlement.pct ?? 0) ||
        b.slowSettlement.n - a.slowSettlement.n ||
        a.supplierName.localeCompare(b.supplierName) ||
        a.supplierId.localeCompare(b.supplierId),
    );

  return {
    subcontractorsConsidered: performances.length,
    subcontractorsWithRecord: withRecord.length,
    subcontractorsEmpty: performances.length - withRecord.length,
    rows,
    withheldPunctuality,
    withheldOverBilling,
    withheldSettlement,
    overBillingFlags,
    slowSettlementFlags,
  };
}

// ---------------------------------------------------------------------------
// Labelled metrics
// ---------------------------------------------------------------------------

/** The ratios: DERIVED — exact ratios over the shipped measurement, floored. */
export function subcontractorReliabilityMetric(
  s: SubcontractorScoreboard,
): LabelledMetric<SubcontractorScoreboard> {
  return labelled(s, {
    kind: "derived",
    basis:
      "Each CIS subcontractor's delivery punctuality, over-invoicing and settlement speed are read " +
      "from the shipped supplier-performance measurement — never recomputed — and shown side by " +
      "side, each with its own sample size. A rate is withheld below " +
      `${MIN_RATED_SAMPLE} comparable records, so a single late delivery can never read as a ` +
      "record. There is deliberately no combined score: the three measures count different things, " +
      "and settlement speed measures how fast WE pay, not the subcontractor's conduct.",
    computedFrom: [
      { label: "Compare suppliers", href: "/suppliers/compare" },
      { label: "CIS subcontractors", href: "/cis" },
    ],
    sampleFloorApplied:
      s.withheldPunctuality > 0 || s.withheldOverBilling > 0 || s.withheldSettlement > 0,
  });
}

/** The flags: HEURISTIC — the thresholds are choices, stated verbatim. */
export function subcontractorRiskFlagsMetric(
  s: SubcontractorScoreboard,
): LabelledMetric<{
  overBillingFlags: SubcontractorScoreRow[];
  slowSettlementFlags: SubcontractorScoreRow[];
}> {
  return labelled(
    { overBillingFlags: s.overBillingFlags, slowSettlementFlags: s.slowSettlementFlags },
    {
      kind: "heuristic",
      basis:
        `Flagged for over-invoicing when more than ${SUPPLIER_OVERBILL_FLAG_PCT}% of a ` +
        "subcontractor's purchase-order-linked bills exceeded the committed order total. Flagged " +
        `for slow settlement when more than ${SUPPLIER_SLOW_SETTLEMENT_PCT}% of their fully-settled ` +
        "bills took over 60 days to pay — that measures how fast WE pay, a retention risk, not " +
        `their conduct. Both thresholds are screening lines, not measurements, and both are ` +
        `withheld below ${MIN_RATED_SAMPLE} comparable records.`,
      computedFrom: [{ label: "Compare suppliers", href: "/suppliers/compare" }],
      sampleFloorApplied: s.withheldOverBilling > 0 || s.withheldSettlement > 0,
    },
  );
}
