import { sumMoney } from "@/lib/money";
import {
  MIN_RATED_SAMPLE,
  isRated,
  ratio,
  type Ratio,
  type SupplierPerformance,
} from "@/lib/suppliers/performance";
import { labelled, type LabelledMetric } from "./provenance";

/**
 * SUPPLIER PERFORMANCE — the org-wide ROLLUP. PURE.
 *
 * This module composes the SHIPPED per-supplier measurement
 * (lib/suppliers/performance.ts → `computeSupplierPerformance`) into a
 * company-level picture: who your most and least reliable suppliers are, who
 * you settle slowly, who invoices over the order, and how much of the roster
 * has too little history to judge. It ADDS NO NEW MEASUREMENT — every input row
 * here is a `SupplierPerformance` the authority already produced, and the only
 * arithmetic below is summing and ratio-ing figures that lib already computed.
 * The compose-don't-re-detect rule (server/services/intelligence.ts header) is
 * absolute here: punctuality, over-billing and settlement speed are NEVER
 * re-derived — they are consumed.
 *
 * ── NO COMPOSITE SCORE, FOR THE SAME REASON THE LIB HAS NONE ─────────────────
 * lib/suppliers/performance.ts header points 1–2 refuse a single "supplier
 * score": the groups have DIFFERENT DENOMINATORS (deliveries, orders, bills)
 * and measure DIFFERENT PARTIES (their punctuality vs OUR payment speed), so no
 * honest arithmetic combines them. That refusal survives the rollup unchanged:
 * there is deliberately no single blended index or opaque grade here, and the
 * source ratchet in __tests__/intelligence/source-assertions.test.ts sweeps
 * this file for the forbidden composite-score identifiers. A buyer picks a
 * COLUMN and the rollup ranks on that one column, naming it — never a blended
 * number.
 *
 * ── SAMPLE FLOORS TRAVEL WITH THE ROLLUP ────────────────────────────────────
 * A supplier below MIN_RATED_SAMPLE on a measure is WITHHELD from that
 * measure's ranking and COUNTED, never ranked on a rate it has not earned —
 * the lib's `Ratio`/`ratio()` discipline applied to the roster. "100% late from
 * one delivery" cannot reach a "least reliable" list; it lands in the withheld
 * count instead, which the surface states.
 *
 * ── KINDS ────────────────────────────────────────────────────────────────────
 *   · Reliability + settlement rankings and the org aggregate: DERIVED — exact
 *     sums and ratios over the lib's own per-supplier figures, reproducible from
 *     the inputs alone.
 *   · The over-billing and slow-settlement FLAGS: HEURISTIC — a threshold
 *     somebody chose, stated verbatim in the basis.
 *
 * Whole-history like the per-supplier surface it composes: there is NO window.
 */

// ---------------------------------------------------------------------------
// The stated thresholds (quoted verbatim in the heuristic basis)
// ---------------------------------------------------------------------------

/** Over-invoicing flag: a supplier billed over the order on MORE than this %. */
export const SUPPLIER_OVERBILL_FLAG_PCT = 20;

/**
 * Slow-settlement flag: more than this % of a supplier's SETTLED bills took
 * longer than 60 days to pay. This measures OUR behaviour, not theirs — it is a
 * retention-risk signal, and the flag says so.
 */
export const SUPPLIER_SLOW_SETTLEMENT_PCT = 25;

/** How many suppliers each ranked list names. A cap, not a page. */
export const SUPPLIER_ROLLUP_TOP_N = 5;

// ---------------------------------------------------------------------------
// Output rows
// ---------------------------------------------------------------------------

/** A drill-through to a supplier's own measured record. */
function supplierHref(supplierId: string): string {
  return `/suppliers/${supplierId}/performance`;
}

/**
 * One supplier's DELIVERY reliability, echoed from the lib. `punctuality` is
 * the lib's own late-rate Ratio (late / judgeable deliveries) — restated, never
 * recomputed. A supplier only appears in a ranking when this Ratio is rated.
 */
export type SupplierReliabilityRow = {
  supplierId: string;
  supplierName: string;
  href: string;
  /** Posted deliveries — the lib's `delivery.deliveries`. */
  deliveries: number;
  /** Late / judgeable, the lib's own floored Ratio. */
  punctuality: Ratio;
};

/** One supplier's settlement speed, with the derived over-60-day share. */
export type SupplierSettlementRow = {
  supplierId: string;
  supplierName: string;
  href: string;
  /** Fully-settled, dated bills — the lib's `settlement.n`. */
  settledBills: number;
  /** over60 / settled, floored by the same MIN_RATED_SAMPLE via ratio(). */
  slowShare: Ratio;
};

/** One supplier flagged for over-invoicing, with the evidence behind the flag. */
export type SupplierOverBillRow = {
  supplierId: string;
  supplierName: string;
  href: string;
  /** Over-billed / PO-linked-billed orders — the lib's own Ratio. */
  overBilled: Ratio;
  /** Σ excess on over-billed orders (£) — the lib's `price.overBilledExcess`. */
  overBilledExcess: number;
};

export type SupplierPerformanceRollup = {
  /** Every supplier the roster asked about. */
  suppliersConsidered: number;
  /** Suppliers with ANY measurable history (the lib's `empty` is false). */
  suppliersWithRecord: number;
  /** Suppliers we have never traded with — shown apart, never as a clean sheet. */
  suppliersEmpty: number;

  /**
   * ORG-WIDE PUNCTUALITY. late / judgeable deliveries summed across every
   * supplier, then floored by the same ratio() the lib uses — DERIVED. Below
   * MIN_RATED_SAMPLE judgeable deliveries org-wide, `pct` is null.
   */
  orgPunctuality: Ratio;

  /** Lowest late-rate first (rated suppliers only), top N. */
  mostReliable: SupplierReliabilityRow[];
  /** Highest late-rate first (rated suppliers only), top N. */
  leastReliable: SupplierReliabilityRow[];
  /** Suppliers with judgeable deliveries but too few to rate — withheld. */
  withheldDeliveryRating: number;

  /** Slowest-settling first (rated suppliers only), top N. */
  slowestSettling: SupplierSettlementRow[];
  /** Suppliers with settled bills but too few to rate settlement speed. */
  withheldSettlementRating: number;

  /** Suppliers over the over-billing threshold (heuristic), worst first. */
  overBillingFlags: SupplierOverBillRow[];
  /** Suppliers with PO-linked bills but too few to rate over-billing. */
  withheldPriceRating: number;
  /** Σ over-billed excess across ALL suppliers (£) — DERIVED. */
  overBilledExcessTotal: number;

  /** Suppliers over the slow-settlement threshold (heuristic), slowest first. */
  slowSettlementFlags: SupplierSettlementRow[];
};

// ---------------------------------------------------------------------------
// The rollup
// ---------------------------------------------------------------------------

export function computeSupplierPerformanceRollup(
  performances: SupplierPerformance[],
): SupplierPerformanceRollup {
  const withRecord = performances.filter((p) => !p.empty);

  // ── Org-wide punctuality: sum the lib's own numerators/denominators ────────
  // punctuality.n is JUDGEABLE posted deliveries; punctuality.count is the late
  // subset. Summing both and re-flooring with ratio() gives the org late rate
  // under the identical MIN_RATED_SAMPLE convention. No new date arithmetic.
  let lateTotal = 0;
  let judgeableTotal = 0;
  for (const p of performances) {
    lateTotal += p.delivery.punctuality.count;
    judgeableTotal += p.delivery.punctuality.n;
  }
  const orgPunctuality = ratio(lateTotal, judgeableTotal);

  // ── Delivery reliability rankings ──────────────────────────────────────────
  const reliabilityRows: SupplierReliabilityRow[] = withRecord.map((p) => ({
    supplierId: p.supplierId,
    supplierName: p.supplierName,
    href: supplierHref(p.supplierId),
    deliveries: p.delivery.deliveries,
    punctuality: p.delivery.punctuality,
  }));
  const ratedReliability = reliabilityRows.filter((r) => isRated(r.punctuality));
  const withheldDeliveryRating = reliabilityRows.filter(
    (r) => r.punctuality.n > 0 && !isRated(r.punctuality),
  ).length;

  // Most reliable = LOWEST late rate; then more evidence, then a stable name/id
  // tiebreak so the list never flickers between renders.
  const mostReliable = [...ratedReliability]
    .sort(
      (a, b) =>
        a.punctuality.pct! - b.punctuality.pct! ||
        b.punctuality.n - a.punctuality.n ||
        a.supplierName.localeCompare(b.supplierName) ||
        a.supplierId.localeCompare(b.supplierId),
    )
    .slice(0, SUPPLIER_ROLLUP_TOP_N);
  const leastReliable = [...ratedReliability]
    .sort(
      (a, b) =>
        b.punctuality.pct! - a.punctuality.pct! ||
        b.punctuality.n - a.punctuality.n ||
        a.supplierName.localeCompare(b.supplierName) ||
        a.supplierId.localeCompare(b.supplierId),
    )
    .slice(0, SUPPLIER_ROLLUP_TOP_N);

  // ── Settlement speed (OUR payment behaviour) ───────────────────────────────
  // slowShare = over60 / settled, floored by ratio(): with settlement.n >= 5 it
  // is rated, below that it is withheld and counted.
  const settlementRows: SupplierSettlementRow[] = withRecord.map((p) => ({
    supplierId: p.supplierId,
    supplierName: p.supplierName,
    href: supplierHref(p.supplierId),
    settledBills: p.settlement.n,
    slowShare: ratio(p.settlement.bands.over60, p.settlement.n),
  }));
  const ratedSettlement = settlementRows.filter((r) => isRated(r.slowShare));
  const withheldSettlementRating = settlementRows.filter(
    (r) => r.slowShare.n > 0 && !isRated(r.slowShare),
  ).length;
  const slowestSettling = [...ratedSettlement]
    .sort(
      (a, b) =>
        b.slowShare.pct! - a.slowShare.pct! ||
        b.slowShare.n - a.slowShare.n ||
        a.supplierName.localeCompare(b.supplierName) ||
        a.supplierId.localeCompare(b.supplierId),
    )
    .slice(0, SUPPLIER_ROLLUP_TOP_N);

  // ── Price behaviour ────────────────────────────────────────────────────────
  const overBillRows: SupplierOverBillRow[] = withRecord.map((p) => ({
    supplierId: p.supplierId,
    supplierName: p.supplierName,
    href: supplierHref(p.supplierId),
    overBilled: p.price.overBilled,
    overBilledExcess: p.price.overBilledExcess,
  }));
  const withheldPriceRating = overBillRows.filter(
    (r) => r.overBilled.n > 0 && !isRated(r.overBilled),
  ).length;
  const overBilledExcessTotal = sumMoney(performances.map((p) => p.price.overBilledExcess));

  // ── Heuristic flags — thresholds applied, rated samples only ───────────────
  const overBillingFlags = overBillRows
    .filter((r) => isRated(r.overBilled) && r.overBilled.pct! > SUPPLIER_OVERBILL_FLAG_PCT)
    .sort(
      (a, b) =>
        b.overBilled.pct! - a.overBilled.pct! ||
        b.overBilledExcess - a.overBilledExcess ||
        a.supplierName.localeCompare(b.supplierName) ||
        a.supplierId.localeCompare(b.supplierId),
    )
    .slice(0, SUPPLIER_ROLLUP_TOP_N);

  const slowSettlementFlags = ratedSettlement
    .filter((r) => r.slowShare.pct! > SUPPLIER_SLOW_SETTLEMENT_PCT)
    .sort(
      (a, b) =>
        b.slowShare.pct! - a.slowShare.pct! ||
        b.slowShare.n - a.slowShare.n ||
        a.supplierName.localeCompare(b.supplierName) ||
        a.supplierId.localeCompare(b.supplierId),
    )
    .slice(0, SUPPLIER_ROLLUP_TOP_N);

  return {
    suppliersConsidered: performances.length,
    suppliersWithRecord: withRecord.length,
    suppliersEmpty: performances.length - withRecord.length,
    orgPunctuality,
    mostReliable,
    leastReliable,
    withheldDeliveryRating,
    slowestSettling,
    withheldSettlementRating,
    overBillingFlags,
    withheldPriceRating,
    overBilledExcessTotal,
    slowSettlementFlags,
  };
}

// ---------------------------------------------------------------------------
// Labelled metrics
// ---------------------------------------------------------------------------

/**
 * Reliability + settlement: DERIVED. Exact sums and ratios over the shipped
 * measurement, floored on the same sample convention.
 */
export function supplierReliabilityMetric(
  r: SupplierPerformanceRollup,
): LabelledMetric<SupplierPerformanceRollup> {
  return labelled(r, {
    kind: "derived",
    basis:
      "Each supplier's delivery punctuality and settlement speed are read from the shipped " +
      "supplier-performance measurement and rolled up, never recomputed: org-wide punctuality " +
      "sums late against judgeable posted deliveries across all suppliers, and the rankings " +
      "order suppliers by that one named column. A supplier is ranked only once it has at least " +
      `${MIN_RATED_SAMPLE} comparable records; below that its rate is withheld and it is counted, ` +
      "so a single late delivery can never read as a performance record. There is no combined " +
      "score — deliveries, orders and bills count different things and one of them measures how " +
      "fast we pay, not how the supplier performs.",
    computedFrom: [
      { label: "Compare suppliers", href: "/suppliers/compare" },
      { label: "Suppliers", href: "/suppliers" },
    ],
    sampleFloorApplied: r.withheldDeliveryRating > 0 || r.withheldSettlementRating > 0,
  });
}

/**
 * Over-billing + slow-settlement flags: HEURISTIC. The thresholds are choices,
 * and they are stated verbatim.
 */
export function supplierRiskFlagsMetric(
  r: SupplierPerformanceRollup,
): LabelledMetric<{
  overBillingFlags: SupplierOverBillRow[];
  slowSettlementFlags: SupplierSettlementRow[];
}> {
  return labelled(
    { overBillingFlags: r.overBillingFlags, slowSettlementFlags: r.slowSettlementFlags },
    {
      kind: "heuristic",
      basis:
        `Flagged for over-invoicing when more than ${SUPPLIER_OVERBILL_FLAG_PCT}% of a supplier's ` +
        "purchase-order-linked bills exceeded the committed order total (the over-billed verdict " +
        "comes from the billing authority, tolerance included). Flagged for slow settlement when " +
        `more than ${SUPPLIER_SLOW_SETTLEMENT_PCT}% of a supplier's fully-settled bills took over ` +
        "60 days to pay — that measures how fast WE pay, a retention risk, not the supplier's own " +
        "conduct. Both thresholds are screening lines, not measurements, and both are withheld " +
        `below ${MIN_RATED_SAMPLE} comparable records.`,
      computedFrom: [{ label: "Compare suppliers", href: "/suppliers/compare" }],
      sampleFloorApplied: r.withheldPriceRating > 0 || r.withheldSettlementRating > 0,
    },
  );
}
