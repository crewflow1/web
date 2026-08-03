import { round2 } from "@/lib/money";

/**
 * OPERATIONAL STOCK — the REPLENISHMENT rule, in one pure place.
 *
 * PURE: no I/O, no server-only imports, unit-tested directly. It takes a fully
 * folded position (available quantity already summed from the movement ledger by
 * lib/stock/balance.ts) and decides, deterministically, which items are AT OR
 * BELOW their reorder point and how many to buy.
 *
 * THE ACCOUNTING BOUNDARY (see lib/stock/movements.ts for the full statement):
 * every number here is a QUANTITY in the item's own unit. There is no cost, no
 * price and no `finances` reachable from this module — the suggestion feeds a
 * material request, which is itself quantity-only. Attaching a value here is the
 * first step to double-counting spend the supplier bill already recorded. Stock
 * valuation is CEO decision D1 and is UNDECIDED.
 *
 * ── THE REORDER POINT IS `reorder_level`, REUSED ─────────────────────────────
 * There is no separate `reorder_point` field. `reorder_level` (20261063000000)
 * already IS the reorder point — the same inclusive threshold lib/stock/balance
 * folds into the `low` / `out` states. Replenishment reads it, it does not
 * duplicate it. `reorderPoint` below is that value, renamed only for clarity at
 * this call site.
 *
 * ── HONEST BY CONSTRUCTION ───────────────────────────────────────────────────
 * Three rules, and every one of them is "say less rather than guess":
 *   1. NO THRESHOLD → NOT LISTED. An item with no reorder point is the long
 *      tail nobody tracks; it never appears, exactly as it never raises a
 *      low-stock signal. "Only items with a set threshold."
 *   2. ABOVE THE POINT → NOT LISTED. available <= reorderPoint, INCLUSIVE, the
 *      same boundary as stockLevel: at the point counts, one above does not.
 *   3. NO DETERMINABLE QUANTITY → NOT LISTED. The suggested amount comes ONLY
 *      from data the user set: a fixed reorderQuantity, or failing that the
 *      order-up-to shortfall (targetLevel − available). If neither yields a
 *      positive number the item is below its point but produces NO suggestion —
 *      it is never handed a fabricated quantity to buy.
 *
 * Retired items are excluded: a discontinued product sitting at zero is the
 * expected end state, not something to re-order (the summariseStock reasoning).
 */

/** One folded item position, everything the rule needs and nothing it doesn't. */
export interface ReorderItemInput {
  id: string;
  name: string;
  unit: string;
  active: boolean;
  /** Summed from the movement ledger (lib/stock/balance.ts). */
  available: number;
  /** stock_items.reorder_level — the reorder point. Null = not tracked. */
  reorderPoint: number | null;
  /** stock_items.reorder_quantity — the fixed batch. Null = no fixed batch. */
  reorderQuantity: number | null;
  /** stock_items.target_level — the order-up-to level. Null = no target. */
  targetLevel: number | null;
}

/** Where a suggested quantity came from — surfaced so the UI can be honest. */
export type ReplenishmentBasis = "fixed_batch" | "order_up_to";

/** A single, actionable "buy N of this" line. `suggestedQuantity` is always > 0. */
export interface ReplenishmentSuggestion {
  itemId: string;
  name: string;
  unit: string;
  available: number;
  reorderPoint: number;
  suggestedQuantity: number;
  basis: ReplenishmentBasis;
}

/**
 * The suggestion for ONE item, or null when it is not a replenishment candidate.
 * Exported so a caller (e.g. the handoff) can re-derive a single item's honest
 * quantity without trusting a client-supplied number.
 */
export function suggestReplenishment(item: ReorderItemInput): ReplenishmentSuggestion | null {
  // Rule 0: retired items are never re-ordered.
  if (!item.active) return null;
  // Rule 1: no reorder point set → not tracked, never listed.
  if (item.reorderPoint === null) return null;

  const reorderPoint = round2(item.reorderPoint);
  const available = round2(item.available);
  // Rule 2: only at or below the point, inclusive (matches stockLevel).
  if (available > reorderPoint) return null;

  // Rule 3: the quantity comes only from data the user set. A fixed batch wins;
  // otherwise fall back to the order-up-to shortfall. Never invented.
  let suggestedQuantity: number | null = null;
  let basis: ReplenishmentBasis | null = null;
  if (item.reorderQuantity !== null && item.reorderQuantity > 0) {
    suggestedQuantity = round2(item.reorderQuantity);
    basis = "fixed_batch";
  } else if (item.targetLevel !== null) {
    const shortfall = round2(item.targetLevel - available);
    if (shortfall > 0) {
      suggestedQuantity = shortfall;
      basis = "order_up_to";
    }
  }
  if (suggestedQuantity === null || basis === null || suggestedQuantity <= 0) {
    return null;
  }

  return {
    itemId: item.id,
    name: item.name,
    unit: item.unit,
    available,
    reorderPoint,
    suggestedQuantity,
    basis,
  };
}

/**
 * Every replenishment suggestion for a set of positions, worst first.
 *
 * TOTAL ORDER (the lib/operations/compose.ts discipline): most depleted first
 * (lowest available), then by name, then by id as the final unique tiebreaker,
 * so the list renders identically for any permutation the read returns.
 */
export function computeReplenishment(
  items: readonly ReorderItemInput[],
): ReplenishmentSuggestion[] {
  const out: ReplenishmentSuggestion[] = [];
  for (const item of items) {
    const s = suggestReplenishment(item);
    if (s) out.push(s);
  }
  return out.sort(
    (a, b) =>
      a.available - b.available ||
      a.name.localeCompare(b.name, "en-GB", { sensitivity: "base" }) ||
      a.itemId.localeCompare(b.itemId),
  );
}
