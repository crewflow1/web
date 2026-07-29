import { round2, toPounds } from "@/lib/money";
import { movementEffect } from "./movements";

/**
 * OPERATIONAL STOCK — balance folding and the low-stock rule. PURE: no I/O, no
 * server-only imports, unit-tested directly.
 *
 * THE ACCOUNTING BOUNDARY (see lib/stock/movements.ts for the full statement):
 * these are QUANTITIES ONLY. Nothing in `lib/stock` carries a unit cost, a
 * valuation or a posting, and nothing here can reach `finances` — materials are
 * already expensed by recordSupplierBill, so an issue posts no new cost.
 *
 * THERE IS NO STORED BALANCE, ANYWHERE. `stock_balance()` and the
 * `stock_balances` view do this same fold in SQL; this module does it in
 * TypeScript for surfaces that already hold the movement rows, so the two must
 * agree — hence `movementEffect`, the ONE place a sign is decided, is shared.
 */

/** One movement row, in the columns every surface selects. */
export interface MovementRow {
  id: string;
  stock_item_id: string;
  site_id: string;
  movement_type: string;
  qty: number | string | null;
  effect?: number | string | null;
  occurred_at?: string | null;
}

/** A folded (item, site) balance. */
export interface SiteBalance {
  stockItemId: string;
  siteId: string;
  quantity: number;
}

/**
 * Composite key for the fold. NUL-separated rather than `:` or `-`, because a
 * uuid contains hyphens and a separator that can occur inside either half
 * makes two different pairs collide.
 */
export function balanceKey(stockItemId: string, siteId: string): string {
  return `${stockItemId}\u0000${siteId}`;
}

/**
 * Fold movements into per-(item, site) balances.
 *
 * Every pair that has ever moved appears, INCLUDING pairs that fold to zero: a
 * site that once held 40 blocks and now holds none is a different answer from a
 * site that has never seen a block, and a stock-take needs the first.
 */
export function foldSiteBalances(movements: readonly MovementRow[]): Map<string, SiteBalance> {
  const out = new Map<string, SiteBalance>();
  for (const m of movements) {
    const key = balanceKey(m.stock_item_id, m.site_id);
    const current = out.get(key);
    const effect = movementEffect(m);
    if (current) {
      current.quantity = round2(current.quantity + effect);
    } else {
      out.set(key, { stockItemId: m.stock_item_id, siteId: m.site_id, quantity: effect });
    }
  }
  return out;
}

/**
 * Total held per item, across every site.
 *
 * Accepts either raw movements or already-folded site balances — the item page
 * has the movements, the overview has the view rows, and both must produce the
 * identical number.
 */
export function foldItemTotals(
  input: readonly MovementRow[] | ReadonlyMap<string, SiteBalance>,
): Map<string, number> {
  const balances =
    input instanceof Map ? input : foldSiteBalances(input as readonly MovementRow[]);
  const totals = new Map<string, number>();
  for (const b of balances.values()) {
    totals.set(b.stockItemId, round2((totals.get(b.stockItemId) ?? 0) + b.quantity));
  }
  return totals;
}

/** Where an item stands against its own thresholds. */
export type StockLevel = "out" | "low" | "ok" | "untracked";

/**
 * THE LOW-STOCK RULE, in one place.
 *
 *   out        available <= 0. Always reported, threshold or not — "we have
 *              none" needs no configuration to be worth saying.
 *   low        available <= reorder_level, INCLUSIVE. Inclusive because a
 *              reorder level IS the trigger point: setting it to 20 means "tell
 *              me at 20", not "tell me at 19". The database comment on
 *              stock_items.reorder_level says the same thing.
 *   untracked  no reorder_level and stock on hand. The long tail nobody counts
 *              closely; it is never flagged and never counted as healthy
 *              either, because CrewFlow was never told what healthy is.
 *   ok         above the threshold.
 *
 * A NEGATIVE balance reads as `out`, not as a fourth state. The RPCs refuse to
 * create one (20261065000000), so a negative can only arrive from a direct
 * PostgREST write — and the honest thing to tell a builder about "-4 bags" is
 * that there are none, loudly, on the same line as everything else that is out.
 */
export function stockLevel(available: number, reorderLevel: number | string | null | undefined): StockLevel {
  if (available <= 0) return "out";
  if (reorderLevel === null || reorderLevel === undefined || reorderLevel === "") return "untracked";
  const threshold = round2(toPounds(reorderLevel));
  return available <= threshold ? "low" : "ok";
}

export function isLowStock(available: number, reorderLevel: number | string | null | undefined): boolean {
  const level = stockLevel(available, reorderLevel);
  return level === "low" || level === "out";
}

export const STOCK_LEVEL_LABELS: Record<StockLevel, string> = {
  out: "Out of stock",
  low: "Low",
  ok: "In stock",
  untracked: "In stock",
};

export const STOCK_LEVEL_CLASS: Record<StockLevel, string> = {
  out: "bg-red-100 text-red-800",
  low: "bg-amber-100 text-amber-800",
  ok: "bg-emerald-100 text-emerald-800",
  untracked: "bg-slate-100 text-slate-700",
};

/** An item plus its folded total — what every list row and tile needs. */
export interface ItemPosition {
  id: string;
  name: string;
  unit: string;
  sku: string | null;
  active: boolean;
  reorderLevel: number | null;
  targetLevel: number | null;
  available: number;
  level: StockLevel;
  /** How many to order to reach target_level. Null when there is no target. */
  shortfall: number | null;
}

export interface ItemRowInput {
  id: string;
  name: string;
  unit?: string | null;
  sku?: string | null;
  active?: boolean | null;
  reorder_level?: number | string | null;
  target_level?: number | string | null;
}

const numOrNull = (v: number | string | null | undefined): number | null =>
  v === null || v === undefined || v === "" ? null : round2(toPounds(v));

/**
 * Join the catalogue to the folded totals. Total order with `id` as the final
 * tiebreaker so the register renders identically for any permutation the read
 * returns — the ordering discipline lib/operations/compose.ts sets out.
 *
 * Sort: things that need attention first (out, then low), then the tracked
 * healthy items, then the untracked tail, then by name.
 */
const LEVEL_RANK: Record<StockLevel, number> = { out: 0, low: 1, ok: 2, untracked: 3 };

export function buildItemPositions(
  items: readonly ItemRowInput[],
  totals: ReadonlyMap<string, number>,
): ItemPosition[] {
  return items
    .map((item): ItemPosition => {
      const available = round2(totals.get(item.id) ?? 0);
      const reorderLevel = numOrNull(item.reorder_level);
      const targetLevel = numOrNull(item.target_level);
      return {
        id: item.id,
        name: item.name,
        unit: item.unit?.trim() || "ea",
        sku: item.sku?.trim() || null,
        active: item.active ?? true,
        reorderLevel,
        targetLevel,
        available,
        level: stockLevel(available, reorderLevel),
        shortfall:
          targetLevel === null ? null : Math.max(0, round2(targetLevel - available)),
      };
    })
    .sort(
      (a, b) =>
        LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
        a.name.localeCompare(b.name, "en-GB", { sensitivity: "base" }) ||
        a.id.localeCompare(b.id),
    );
}

/** The overview tiles. Every number here is a real count, never a placeholder. */
export interface StockSummary {
  trackedItems: number;
  activeItems: number;
  outOfStock: number;
  lowStock: number;
  /** Distinct sites currently holding a non-zero quantity of anything. */
  sitesHolding: number;
}

export function summariseStock(
  positions: readonly ItemPosition[],
  balances: ReadonlyMap<string, SiteBalance>,
): StockSummary {
  const active = positions.filter((p) => p.active);
  const sites = new Set<string>();
  for (const b of balances.values()) if (b.quantity !== 0) sites.add(b.siteId);
  return {
    trackedItems: positions.length,
    activeItems: active.length,
    // Retired items are excluded from BOTH attention counts: a discontinued
    // product being at zero is the expected end state, not a problem, and
    // counting it would make the tile permanently red for no reason.
    outOfStock: active.filter((p) => p.level === "out").length,
    lowStock: active.filter((p) => p.level === "low").length,
    sitesHolding: sites.size,
  };
}

/**
 * The low-stock lines a Daily Briefing signal is built from — the ACTIVE items
 * at or below their threshold (or out entirely), worst first.
 */
export function lowStockLines(positions: readonly ItemPosition[]): ItemPosition[] {
  return positions.filter((p) => p.active && (p.level === "out" || p.level === "low"));
}
