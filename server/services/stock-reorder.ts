import "server-only";

import { loadStockPositions, type StockClient } from "@/server/services/stock";
import {
  computeReplenishment,
  suggestReplenishment,
  type ReplenishmentSuggestion,
} from "@/lib/stock/reorder";

/**
 * OPERATIONAL STOCK — the REPLENISHMENT read.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE ACCOUNTING BOUNDARY. Every value returned here is a QUANTITY. There ║
 * ║  is no cost, no price and no `finances` read or write on this path — the ║
 * ║  suggestion feeds a material request, which is itself quantity-only.     ║
 * ║  Stock valuation is CEO decision D1, UNDECIDED. See the 20261107 header. ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ORG-PINNED AND LOUD BY DELEGATION. This module does no raw table reads of its
 * own: it calls `loadStockPositions`, which is where the invariants already
 * live — every query there carries `.eq("org_id", orgId)` (the #456/#468 pin,
 * so a dual-org member's yards never blend) and throws `readFailure` on error
 * (the #480 loud-read doctrine, so an empty replenishment list can never be a
 * swallowed query). Reusing it means the deterministic "below reorder point"
 * answer is folded from the EXACT same movement ledger the /stock overview and
 * the item pages use — the three surfaces can never disagree about a balance.
 *
 * The rule itself is pure and lives in lib/stock/reorder.ts; this file only
 * maps a folded position onto that rule's input.
 */

export type { ReplenishmentSuggestion } from "@/lib/stock/reorder";

/**
 * Every item in the active org that is at or below its reorder point AND has a
 * determinable quantity to buy, worst first. Only items with a set threshold;
 * never a fabricated suggestion (see lib/stock/reorder.ts).
 */
export async function loadReplenishmentSuggestions(
  db: StockClient,
  orgId: string,
): Promise<ReplenishmentSuggestion[]> {
  const { positions } = await loadStockPositions(db, orgId); // org-pinned + loud
  return computeReplenishment(
    positions.map((p) => ({
      id: p.id,
      name: p.name,
      unit: p.unit,
      active: p.active,
      available: p.available,
      reorderPoint: p.reorderLevel,
      reorderQuantity: p.reorderQuantity,
      targetLevel: p.targetLevel,
    })),
  );
}

/**
 * The server-recomputed suggestion for a SPECIFIC set of item ids — the honest
 * basis for the handoff. The action re-derives here rather than trusting a
 * client-posted quantity, so a stale or tampered form can only ever ask for a
 * quantity the current ledger actually justifies. Returns them keyed by item id
 * and in the same worst-first order.
 */
export async function replenishmentSuggestionsForItems(
  db: StockClient,
  orgId: string,
  itemIds: readonly string[],
): Promise<ReplenishmentSuggestion[]> {
  if (itemIds.length === 0) return [];
  const wanted = new Set(itemIds);
  const all = await loadReplenishmentSuggestions(db, orgId);
  return all.filter((s) => wanted.has(s.itemId));
}

export { suggestReplenishment };
