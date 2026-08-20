import { round2, toPounds } from "@/lib/money";
import { movementEffect } from "./movements";
import type { MovementRow } from "./balance";

/**
 * OPERATIONAL STOCK — WEIGHTED-AVERAGE COST VALUATION. PURE: no I/O, no
 * server-only imports, unit-tested directly.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE ACCOUNTING BOUNDARY (full statement in the 20261180000000 migration ║
 * ║  header). CEO decision D1 is DECIDED: WEIGHTED-AVERAGE COST. This module  ║
 * ║  folds the per-row cost facts the database froze onto each movement       ║
 * ║  (`cost_effect`, `unit_cost`) into item valuations and COGS.              ║
 * ║                                                                          ║
 * ║  IT POSTS NOTHING, ANYWHERE, AND NEVER READS OR WRITES `finances`. The    ║
 * ║  company P&L is expensed exactly once, by recordSupplierBill; this        ║
 * ║  valuation is a management-accounting overlay, so a company total can     ║
 * ║  never double-count. COGS-on-issue is surfaced to JOB costing as an       ║
 * ║  ALLOCATION stream (buildStockCogsCostRows) that re-classifies the        ║
 * ║  depot-replenishment spend onto the consuming job — never a new expense.  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * THERE IS NO STORED AVERAGE, ANYWHERE. `stock_valuation` does this same fold in
 * SQL; this module does it in TypeScript for surfaces that already hold the
 * movement rows, so the two must agree — hence the numerator/denominator rule
 * here is byte-for-byte the view's:
 *
 *     on_hand       = Σ effect                 (physical quantity)
 *     book_value    = Σ cost_effect            (£ in the costed pool)
 *     costed_qty    = Σ costed_qty_effect      (units in the costed pool, CAPPED)
 *     avg_unit_cost = book_value / costed_qty  (null when costed_qty ≤ 0)
 *
 * COSTED_QTY IS TRACKED BY ITS OWN CAPPED FACT, NOT BY `effect`. An OUT movement
 * that draws PHYSICAL units across the costed↔uncosted boundary releases cost for
 * only the costed part it holds (the DB caps `cost_effect`/`costed_qty_effect` at
 * the pool), so `costed_qty` and `book_value` FLOOR AT 0 and can never go
 * negative — the S1 defect this closes. Deriving costed_qty from physical
 * `effect` would let a −6 issue against a 5-unit costed pool report costed_qty
 * −1 / book_value −£8, poisoning the company total.
 *
 * A NULL-cost movement (every pre-20261180 row, a hand receipt with no price, a
 * fully-uncosted OUT) is UNCOSTED: it contributes to neither sum, so it never
 * drags the average and a division by zero is impossible. Physical on-hand still
 * counts it, so `uncosted_qty = on_hand − costed_qty` reports it honestly.
 */

/** Unit costs are held to 4dp in the database (numeric(12,4)); mirror that. */
export function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10_000) / 10_000;
}

/** A movement row that MAY carry the frozen cost facts. */
export interface CostedMovementRow extends MovementRow {
  /** Signed value impact (£). Null = uncosted (outside the valuation pool). */
  cost_effect?: number | string | null;
  /**
   * Signed COSTED-QUANTITY impact (units) — the capped pool quantity, which
   * differs from physical `effect` at the costed↔uncosted boundary. Null =
   * uncosted. costed_qty of an item = Σ costed_qty_effect (floors at 0).
   */
  costed_qty_effect?: number | string | null;
  /** Per-unit cost basis used (£/unit). Null = uncosted. */
  unit_cost?: number | string | null;
  /** Present on issue rows; the job the COGS is allocated to. */
  job_id?: string | null;
  /** On a `correction` row: the movement it reverses. */
  corrects_movement_id?: string | null;
}

/**
 * The signed VALUE impact of one movement, or null when the row is uncosted.
 *
 * NOT re-derivable from the quantity: the database froze `cost_effect` at insert
 * using the weighted-average at that instant, and that is the only correct
 * answer for an issue. A missing/blank/null value means UNCOSTED, which is a
 * different fact from £0 and must never be coerced to zero.
 */
export function movementCostEffect(row: {
  cost_effect?: number | string | null;
}): number | null {
  const c = row.cost_effect;
  if (c === undefined || c === null || c === "") return null;
  return round2(toPounds(c));
}

/** True when the movement carries a known cost (is inside the valuation pool). */
export function isCosted(row: { cost_effect?: number | string | null }): boolean {
  return movementCostEffect(row) !== null;
}

/**
 * The signed COSTED-QUANTITY impact of one movement, or null when uncosted.
 *
 * The DB froze this (capped at the costed pool for an OUT movement) so it differs
 * from physical `effect` exactly at the boundary. Summing it gives a costed_qty
 * that floors at 0 — see the module header.
 */
export function movementCostedQtyEffect(row: {
  costed_qty_effect?: number | string | null;
}): number | null {
  const q = row.costed_qty_effect;
  if (q === undefined || q === null || q === "") return null;
  return round2(toPounds(q));
}

/** A folded (item) valuation — the shape `stock_valuation` returns per row. */
export interface ItemValuation {
  stockItemId: string;
  /** Physical quantity on hand (Σ effect) — matches foldItemTotals. */
  onHand: number;
  /** The part of on-hand that carries a known cost. */
  costedQty: number;
  /** on-hand − costed-qty: pre-cost-era / hand-receipt stock, at unknown cost. */
  uncostedQty: number;
  /** Weighted-average valuation (£): Σ cost_effect. */
  bookValue: number;
  /** book value / costed qty, 4dp. Null when nothing is costed yet. */
  avgUnitCost: number | null;
}

/** The weighted-average unit cost, or null when there is no costed quantity. */
export function weightedAverageUnitCost(
  bookValue: number,
  costedQty: number,
): number | null {
  return costedQty > 0 ? round4(bookValue / costedQty) : null;
}

/**
 * Fold movements into per-item weighted-average valuations.
 *
 * Every item that has ever moved appears, INCLUDING items that fold to zero
 * quantity — a stock-take needs "used to hold, now empty" told apart from
 * "never seen", exactly as foldSiteBalances does for quantities.
 */
export function foldItemValuations(
  movements: readonly CostedMovementRow[],
): Map<string, ItemValuation> {
  const out = new Map<string, ItemValuation>();
  for (const m of movements) {
    let v = out.get(m.stock_item_id);
    if (!v) {
      v = {
        stockItemId: m.stock_item_id,
        onHand: 0,
        costedQty: 0,
        uncostedQty: 0,
        bookValue: 0,
        avgUnitCost: null,
      };
      out.set(m.stock_item_id, v);
    }
    v.onHand = round2(v.onHand + movementEffect(m));
    // Book value and costed quantity come from their OWN capped facts, never
    // from physical `effect` — that is what floors both at 0 across the boundary.
    const cost = movementCostEffect(m);
    if (cost !== null) v.bookValue = round2(v.bookValue + cost);
    const costedQty = movementCostedQtyEffect(m);
    if (costedQty !== null) v.costedQty = round2(v.costedQty + costedQty);
  }
  for (const v of out.values()) {
    v.uncostedQty = round2(v.onHand - v.costedQty);
    v.avgUnitCost = weightedAverageUnitCost(v.bookValue, v.costedQty);
  }
  return out;
}

/**
 * COGS released to each JOB by stock issues, NET OF CORRECTIONS — the material
 * cost a job actually consumed from stock.
 *
 * Only `issue` movements carry a job (an adjustment/transfer never does), and
 * only costed ones contribute; the value is the ABSOLUTE cost (a positive cost
 * of sale), keyed by job_id.
 *
 * A `correction` reversing an issue is a SEPARATE, job-less row (it names the
 * issue via `corrects_movement_id`), so it must be backed out EXPLICITLY or a
 * reversed issue would burden its job for ever — the same "exclude corrected
 * issues" rule the material-fulfilment derivation applies (20261071000000). The
 * correction's cost_effect is the exact positive reversal of the issue's, so the
 * job nets to zero once corrected. Jobs that net to zero are dropped.
 */
export function stockCogsByJob(
  movements: readonly CostedMovementRow[],
): Map<string, number> {
  const out = new Map<string, number>();
  const jobByIssueId = new Map<string, string>();

  for (const m of movements) {
    if (m.movement_type !== "issue" || !m.job_id) continue;
    jobByIssueId.set(m.id, m.job_id);
    const cost = movementCostEffect(m);
    if (cost === null) continue;
    // An issue's cost_effect is negative (a release); job COGS is its magnitude.
    out.set(m.job_id, round2((out.get(m.job_id) ?? 0) + Math.abs(cost)));
  }

  for (const m of movements) {
    if (m.movement_type !== "correction" || !m.corrects_movement_id) continue;
    const job = jobByIssueId.get(m.corrects_movement_id);
    if (!job) continue; // corrects something other than a job-issue
    const cost = movementCostEffect(m);
    if (cost === null) continue;
    out.set(job, round2((out.get(job) ?? 0) - Math.abs(cost)));
  }

  for (const [job, amount] of out) if (amount === 0) out.delete(job);
  return out;
}

/**
 * A finance-row-shaped cost input, byte-compatible with
 * lib/profitability/job-cost-input.CostInputRow, so stock COGS composes into the
 * profitability engine's `materials` bucket exactly as labour composes into
 * `labour` — WITHOUT ever creating a `finances` row.
 */
export type StockCogsCostRow = {
  job_id: string;
  amount: number;
  category: "materials";
};

/**
 * Turn the per-job stock COGS into cost-input rows for computeJobProfitability.
 *
 * WIRED (20261212 wave): composed into live job margins via
 * `buildJobCostInput({ stockCogs })` — loaded per org by
 * `server/services/stock.loadStockCogsCostRows` and surfaced on the dashboard
 * leaderboard, the job summary + commercial pages, CVR/variance, company-health
 * and the profitability report. It remains a DISTINCT, labelled stream each
 * surface composes on purpose (never auto-merged into `finances`), so the streams
 * stay separable and auditable.
 *
 * DOUBLE-COUNT SAFETY (holds under the depot convention): these rows are an
 * ALLOCATION of depot-replenishment spend onto the consuming job, not a new
 * expense — see the 20261180000000 migration header. `lib/stock` posts NOTHING to
 * `finances` (a stock issue creates no finance row; the single expense is
 * `recordSupplierBill`), so folding these into a job's finances-derived cost adds
 * the cost EXACTLY ONCE: a job's material cost reaches its margin through EITHER a
 * direct `finances` materials bill (job-specific purchase) OR a stock issue (drawn
 * from the depot pool), never both — stock-replenishment bills are booked to the
 * depot (`finances.job_id` null) and job-direct purchases are not also issued from
 * stock. The company-level P&L is byte-identical with or without this stream.
 */
export function buildStockCogsCostRows(
  movements: readonly CostedMovementRow[],
): StockCogsCostRow[] {
  const rows: StockCogsCostRow[] = [];
  for (const [job_id, amount] of stockCogsByJob(movements)) {
    if (amount !== 0) rows.push({ job_id, amount, category: "materials" });
  }
  // Total order by job id so the composed cost input is deterministic.
  return rows.sort((a, b) => a.job_id.localeCompare(b.job_id));
}

/** A valuation report line — catalogue identity joined to its folded valuation. */
export interface ValuationReportRow {
  id: string;
  name: string;
  unit: string;
  sku: string | null;
  onHand: number;
  costedQty: number;
  uncostedQty: number;
  avgUnitCost: number | null;
  bookValue: number;
  /** True when some on-hand quantity has no known cost (legacy / hand receipt). */
  hasUncosted: boolean;
}

export interface ValuationReportItemInput {
  id: string;
  name: string;
  unit?: string | null;
  sku?: string | null;
  active?: boolean | null;
}

/**
 * Join the catalogue to the folded valuations for the stock valuation report.
 *
 * Items with a positive on-hand OR a non-zero book value are included; an item
 * that has never moved (no valuation row) still appears with zeroes so the
 * report is a complete statement of the catalogue's value. Sorted by book value
 * descending — the money is what a report is read for — then by name, then by id
 * so the order is total and a paged render can never drop or repeat a row.
 */
export function buildValuationReport(
  items: readonly ValuationReportItemInput[],
  valuations: ReadonlyMap<string, ItemValuation>,
): ValuationReportRow[] {
  return items
    .map((item): ValuationReportRow => {
      const v = valuations.get(item.id);
      const onHand = v ? v.onHand : 0;
      const costedQty = v ? v.costedQty : 0;
      const uncostedQty = v ? v.uncostedQty : 0;
      const bookValue = v ? v.bookValue : 0;
      return {
        id: item.id,
        name: item.name,
        unit: item.unit?.trim() || "ea",
        sku: item.sku?.trim() || null,
        onHand,
        costedQty,
        uncostedQty,
        avgUnitCost: v ? v.avgUnitCost : null,
        bookValue,
        hasUncosted: Math.abs(uncostedQty) > 0,
      };
    })
    .sort(
      (a, b) =>
        b.bookValue - a.bookValue ||
        a.name.localeCompare(b.name, "en-GB", { sensitivity: "base" }) ||
        a.id.localeCompare(b.id),
    );
}

/** The valuation report's headline totals. */
export interface ValuationTotals {
  /** Total book value across every item (£). */
  bookValue: number;
  /** Items with a positive on-hand quantity. */
  itemsInStock: number;
  /** Items whose on-hand carries SOME unknown-cost quantity — the trust caveat. */
  itemsWithUncosted: number;
}

export function summariseValuation(rows: readonly ValuationReportRow[]): ValuationTotals {
  let bookValue = 0;
  let itemsInStock = 0;
  let itemsWithUncosted = 0;
  for (const r of rows) {
    bookValue = round2(bookValue + r.bookValue);
    if (r.onHand > 0) itemsInStock += 1;
    if (r.hasUncosted) itemsWithUncosted += 1;
  }
  return { bookValue, itemsInStock, itemsWithUncosted };
}
