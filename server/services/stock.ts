import "server-only";

import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import {
  buildItemPositions,
  foldItemTotals,
  foldSiteBalances,
  type ItemPosition,
  type MovementRow,
  type SiteBalance,
} from "@/lib/stock/balance";

/**
 * OPERATIONAL STOCK — the read layer behind /stock, its detail routes, the
 * receive-into-stock affordance on the purchase-order surface, and the
 * low-stock briefing signal.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE ACCOUNTING BOUNDARY. Every read in this file returns QUANTITIES.    ║
 * ║  There is no cost, no valuation and no `finances` read or write anywhere ║
 * ║  in the stock surface: purchased materials are already expensed by       ║
 * ║  recordSupplierBill, so issuing stock to a job posts NO new expense — a  ║
 * ║  second posting would double-count the same spend. Stock valuation is    ║
 * ║  CEO decision D1 and is UNDECIDED. See docs/operational-stock.md.        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * TWO INVARIANTS THIS FILE EXISTS TO HOLD:
 *
 * 1. ORG-PINNED, not merely RLS-scoped. `stock_items: members can select` and
 *    `stock_movements: members can select` are both `org_id in (select
 *    current_org_ids())`, which passes for EVERY org the viewer belongs to.
 *    Without the pin a dual-org member working in company A would see company
 *    B's items in the register, /stock/items/[id] would open B's item inside
 *    A's shell, and the issue/transfer pickers would OFFER a site the RPC then
 *    refuses — turning a leak into an unexplainable error. Same class as the
 *    supplier fix in server/services/suppliers.ts and the #456/#459/#461/
 *    #463/#464/#468 read slices. Every query below therefore carries
 *    `.eq("org_id", orgId)`, and __tests__/security/operational-stock.test.ts
 *    counts them against the number of `.select(` calls in this file.
 *
 * 2. LOUD READS (the #480 doctrine). Every read binds `error` and throws
 *    `readFailure(...)`. A stock page that renders "nothing in stock" because
 *    the query was REJECTED is the worst possible failure for this domain: the
 *    empty state and the healthy state are the same picture, and the action it
 *    invites — order more — costs money. The one deliberate exception is
 *    `loadLowStockSignal`, which is best-effort by contract (the briefing must
 *    never break the dashboard) and says so at its own call site.
 *
 * These functions take the Supabase client as an argument (mirrors
 * server/services/sites.ts and server/services/suppliers.ts) so the integration
 * suite can drive the EXACT same queries with a real dual-org user's JWT
 * against real Postgres — removing a pin here goes red in
 * __tests__/integration/rls/stock-isolation.test.ts, not just in review.
 *
 * `stock_items` / `stock_movements` are newer than the generated Supabase
 * types, so the client is accessed through the loose shape below — the same
 * cast style the sites, assets, snags and fleet call sites already use.
 */

type Row = Record<string, unknown>;
type Err = { message?: string | null; code?: string | null } | null;

export type StockClient = { from: (t: string) => StockBuilder };

type StockBuilder = PromiseLike<{ data: Row[] | null; error: Err }> & {
  select: (c: string) => StockBuilder;
  eq: (k: string, v: unknown) => StockBuilder;
  in: (k: string, v: readonly unknown[]) => StockBuilder;
  order: (k: string, o: { ascending: boolean }) => StockBuilder;
  limit: (n: number) => StockBuilder;
  range: (from: number, to: number) => StockBuilder;
  maybeSingle: () => Promise<{ data: Row | null; error: Err }>;
};

/** Upper bound on a catalogue read. Far beyond any 5-50 person builder. */
export const STOCK_ITEM_LIMIT = 1000;
/** How many movements the overview's "recent" feed and a detail page show. */
export const STOCK_RECENT_LIMIT = 50;

export const STOCK_ITEM_COLUMNS =
  "id, name, description, sku, unit, active, preferred_supplier_id, supplier_reference, " +
  "reorder_level, target_level, reorder_quantity, notes, created_at";

export const STOCK_MOVEMENT_COLUMNS =
  "id, stock_item_id, site_id, movement_type, qty, effect, occurred_at, actor_id, notes, " +
  "grn_line_id, job_id, material_request_line_id, transfer_group_id, corrects_movement_id, created_at";

export type StockItemRow = {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  unit: string;
  active: boolean;
  preferred_supplier_id: string | null;
  supplier_reference: string | null;
  reorder_level: number | string | null;
  target_level: number | string | null;
  reorder_quantity: number | string | null;
  notes: string | null;
  created_at: string;
};

export type StockMovementRow = MovementRow & {
  actor_id: string | null;
  notes: string | null;
  grn_line_id: string | null;
  job_id: string | null;
  material_request_line_id: string | null;
  transfer_group_id: string | null;
  corrects_movement_id: string | null;
  created_at: string;
};

/** The catalogue for one org, name-ordered with `id` as the final tiebreaker. */
export async function listStockItems(
  db: StockClient,
  orgId: string,
  opts: { limit?: number } = {},
): Promise<StockItemRow[]> {
  const { data, error } = await db
    .from("stock_items")
    .select(STOCK_ITEM_COLUMNS)
    .eq("org_id", orgId) // ACTIVE-ORG PIN
    .order("name", { ascending: true })
    .order("id", { ascending: true })
    // F-1: the caller-supplied limit is a bounded sample, but PostgREST clamps
    // every read to 1000 — so cap it provably (never above the catalogue ceiling)
    // rather than let a large `opts.limit` masquerade as a complete read.
    .limit(Math.min(opts.limit ?? STOCK_ITEM_LIMIT, STOCK_ITEM_LIMIT));
  if (error) throw readFailure("stock: item register", error);
  return (data ?? []) as unknown as StockItemRow[];
}

/**
 * One item by id, constrained to the ACTIVE org.
 *
 * Returns null when the item does not exist OR belongs to another org — the two
 * cases are deliberately indistinguishable, so callers `notFound()` either way.
 */
export async function loadStockItem(
  db: StockClient,
  orgId: string,
  itemId: string,
): Promise<StockItemRow | null> {
  const { data, error } = await db
    .from("stock_items")
    .select(STOCK_ITEM_COLUMNS)
    .eq("id", itemId)
    .eq("org_id", orgId) // ACTIVE-ORG PIN
    .maybeSingle();
  if (error) throw readFailure("stock: item by id", error);
  return (data as StockItemRow | null) ?? null;
}

/**
 * Every movement for the org, newest first — the fold input for balances.
 *
 * Read in full rather than through the `stock_balances` view because the SAME
 * rows drive the balances AND the history panel, and one read that both use can
 * never disagree with itself. The (org_id, occurred_at desc, id desc) index
 * covers this exactly.
 *
 * PAGED (F-1). This is a COMPLETENESS-critical read: `foldSiteBalances` sums the
 * whole ledger, so a truncated read silently mis-states every on-hand quantity.
 * A single `.limit(N)` cannot be honest here — PostgREST clamps every response
 * to `max_rows` (=1000), so any bare cap silently drops movements 1001+ and the
 * folded balance under-reports with no error. `fetchAllRows` pages under the cap
 * on the unique `(occurred_at desc, id desc)` total order, returning the entire
 * ledger. Callers that only want a "recent" slice take it in TypeScript from the
 * complete set (e.g. `movements.slice(0, 12)`), so the display cap never re-caps
 * the fold input.
 */
export async function listStockMovements(
  db: StockClient,
  orgId: string,
  opts: { itemId?: string; siteId?: string } = {},
): Promise<StockMovementRow[]> {
  const { data, error } = await fetchAllRows<Row>((from, to) => {
    let q = db
      .from("stock_movements")
      .select(STOCK_MOVEMENT_COLUMNS)
      .eq("org_id", orgId); // ACTIVE-ORG PIN
    if (opts.itemId) q = q.eq("stock_item_id", opts.itemId);
    if (opts.siteId) q = q.eq("site_id", opts.siteId);
    return q
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to);
  });
  if (error) throw readFailure("stock: movements", error);
  return (data ?? []) as unknown as StockMovementRow[];
}

/** Everything /stock and /stock/items need, folded once. */
export interface StockPositionSnapshot {
  items: StockItemRow[];
  movements: StockMovementRow[];
  balances: Map<string, SiteBalance>;
  positions: ItemPosition[];
}

export async function loadStockPositions(
  db: StockClient,
  orgId: string,
): Promise<StockPositionSnapshot> {
  const [items, movements] = await Promise.all([
    listStockItems(db, orgId),
    listStockMovements(db, orgId),
  ]);
  const balances = foldSiteBalances(movements);
  const positions = buildItemPositions(items, foldItemTotals(balances));
  return { items, movements, balances, positions };
}

/**
 * Which delivery lines on one purchase order are ALREADY in stock.
 *
 * Drives the "receive into stock" affordance on the PO page: a line that has a
 * receipt movement shows where it went instead of offering the form again. The
 * database is still the authority (the partial unique index makes the write
 * idempotent), so this is an explanation, never a gate.
 */
export async function loadStockedGrnLines(
  db: StockClient,
  orgId: string,
  grnLineIds: readonly string[],
): Promise<Map<string, { movementId: string; siteId: string; itemId: string }>> {
  const out = new Map<string, { movementId: string; siteId: string; itemId: string }>();
  if (grnLineIds.length === 0) return out;
  const { data, error } = await db
    .from("stock_movements")
    .select("id, grn_line_id, site_id, stock_item_id")
    .eq("org_id", orgId) // ACTIVE-ORG PIN
    .eq("movement_type", "receipt")
    .in("grn_line_id", grnLineIds)
    .limit(STOCK_RECENT_LIMIT);
  if (error) throw readFailure("stock: grn lines already received", error);
  for (const row of data ?? []) {
    const key = typeof row.grn_line_id === "string" ? row.grn_line_id : "";
    if (!key) continue;
    out.set(key, {
      movementId: String(row.id),
      siteId: String(row.site_id),
      itemId: String(row.stock_item_id),
    });
  }
  return out;
}

/** Item options for a picker — active items, plus whichever one is selected. */
export type StockItemOption = { id: string; name: string; unit: string; active: boolean };

export async function listStockItemOptions(
  db: StockClient,
  orgId: string,
  opts: { keepId?: string | null } = {},
): Promise<StockItemOption[]> {
  const { data, error } = await db
    .from("stock_items")
    .select("id, name, unit, active")
    .eq("org_id", orgId) // ACTIVE-ORG PIN
    .order("name", { ascending: true })
    .order("id", { ascending: true })
    .limit(STOCK_ITEM_LIMIT);
  // A picker that silently loses its options offers an empty dropdown and the
  // user concludes they have no stock items. Loud, like every other read here.
  if (error) throw readFailure("stock: item options", error);
  const rows = (data ?? []) as unknown as StockItemOption[];
  return rows.filter((r) => r.active || (opts.keepId != null && r.id === opts.keepId));
}

/**
 * The low-stock rollup for the Daily Briefing.
 *
 * BEST-EFFORT BY CONTRACT, and the ONLY read in this file that is: the briefing
 * is an additive dashboard section that must never break the page it sits on
 * (server/services/briefing.ts wraps its whole build in the same posture). A
 * failed read here degrades to "no low-stock signal", which is the same outcome
 * as a tenant that tracks no thresholds — it cannot invent a signal, only miss
 * one, and the /stock page itself remains loud.
 */
export interface LowStockRollup {
  /** ACTIVE items at or below their reorder level (excluding the ones at zero). */
  low: number;
  /** ACTIVE items with nothing left at all. */
  out: number;
  /** The worst-off item's name, for the briefing sentence. */
  worstName: string | null;
}

export const EMPTY_LOW_STOCK: LowStockRollup = { low: 0, out: 0, worstName: null };

export async function loadLowStockSignal(
  db: StockClient,
  orgId: string,
): Promise<LowStockRollup> {
  try {
    const { items, positions } = await loadStockPositions(db, orgId);
    if (items.length === 0) return EMPTY_LOW_STOCK;
    const active = positions.filter((p) => p.active);
    const out = active.filter((p) => p.level === "out");
    const low = active.filter((p) => p.level === "low");
    // buildItemPositions already sorts out-of-stock first, then low, then by
    // name — so the first element of either list is the worst-off item.
    const worst = out[0] ?? low[0] ?? null;
    return { low: low.length, out: out.length, worstName: worst?.name ?? null };
  } catch {
    return EMPTY_LOW_STOCK;
  }
}
