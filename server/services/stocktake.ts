import "server-only";

import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import {
  buildLinePositions,
  type StocktakeItemRefInput,
  type StocktakeLinePosition,
  type StocktakeLineRowInput,
  summariseLines,
  type StocktakeSummary,
} from "@/lib/stocktake/schema";

/**
 * STOCKTAKE / CYCLE-COUNT — the read layer behind /stock/stocktake and its
 * detail route.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE ACCOUNTING BOUNDARY. Every read here returns QUANTITIES — a frozen  ║
 * ║  expected count, a physical count, a variance. No cost, no valuation, no ║
 * ║  `finances` read anywhere. Stock valuation is CEO decision D1 and is     ║
 * ║  UNDECIDED; a valuation report is out of scope.                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * TWO INVARIANTS, the same two server/services/stock.ts holds:
 *
 * 1. ORG-PINNED, not merely RLS-scoped. Both new tables' select policies are
 *    `org_id in (select current_org_ids())`, which passes for EVERY org the
 *    viewer belongs to. Every query below therefore carries `.eq("org_id",
 *    orgId)` on top of RLS, so a dual-org member never sees another of their
 *    own companies' counts inside the active org's shell.
 *
 * 2. LOUD READS (#480). Every read binds `error` and throws `readFailure`. A
 *    stocktake page that renders "no lines" because the query was REJECTED is
 *    the worst failure for this domain — the empty state and the healthy state
 *    look identical, and the action it invites (post a count) changes the ledger.
 *
 * F-1 PAGINATION. Session and line lists page via `fetchAllRows` on a unique
 * total order, never a bare `.limit()` (PostgREST clamps every response to 1000).
 *
 * `stocktake_*` are newer than the generated Supabase types, so the client is
 * accessed through the loose shape below — the sites/assets/stock cast idiom.
 */

type Row = Record<string, unknown>;
type Err = { message?: string | null; code?: string | null } | null;

export type StocktakeClient = { from: (t: string) => StocktakeBuilder };

type StocktakeBuilder = PromiseLike<{ data: Row[] | null; error: Err }> & {
  select: (c: string) => StocktakeBuilder;
  eq: (k: string, v: unknown) => StocktakeBuilder;
  or: (f: string) => StocktakeBuilder;
  order: (k: string, o: { ascending: boolean }) => StocktakeBuilder;
  range: (from: number, to: number) => StocktakeBuilder;
  limit: (n: number) => StocktakeBuilder;
  maybeSingle: () => Promise<{ data: Row | null; error: Err }>;
};

export const STOCKTAKE_SESSION_COLUMNS =
  "id, site_id, reference, status, notes, opened_by, opened_at, posted_by, posted_at, " +
  "cancelled_by, cancelled_at, created_at, updated_at";

export const STOCKTAKE_LINE_COLUMNS =
  "id, session_id, stock_item_id, expected_qty, counted_qty, counted_at, counted_by, " +
  "posted_movement_id, posted_variance, created_at";

export type StocktakeSessionRow = {
  id: string;
  site_id: string;
  reference: string | null;
  status: string;
  notes: string | null;
  opened_by: string | null;
  opened_at: string;
  posted_by: string | null;
  posted_at: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type StocktakeLineRow = StocktakeLineRowInput & {
  session_id: string;
  counted_at: string | null;
  counted_by: string | null;
  created_at: string;
};

/** Every stocktake for the org, newest first. Paged (F-1). */
export async function listStocktakeSessions(
  db: StocktakeClient,
  orgId: string,
): Promise<StocktakeSessionRow[]> {
  const { data, error } = await fetchAllRows<Row>((from, to) =>
    db
      .from("stocktake_sessions")
      .select(STOCKTAKE_SESSION_COLUMNS)
      .eq("org_id", orgId) // ACTIVE-ORG PIN
      .order("opened_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, to),
  );
  if (error) throw readFailure("stocktake: session list", error);
  return (data ?? []) as unknown as StocktakeSessionRow[];
}

/**
 * One session by id, constrained to the ACTIVE org. Returns null when it does
 * not exist OR belongs to another org — indistinguishable, so callers notFound.
 */
export async function loadStocktakeSession(
  db: StocktakeClient,
  orgId: string,
  sessionId: string,
): Promise<StocktakeSessionRow | null> {
  const { data, error } = await db
    .from("stocktake_sessions")
    .select(STOCKTAKE_SESSION_COLUMNS)
    .eq("id", sessionId)
    .eq("org_id", orgId) // ACTIVE-ORG PIN
    .maybeSingle();
  if (error) throw readFailure("stocktake: session by id", error);
  return (data as StocktakeSessionRow | null) ?? null;
}

/** Every line on one session. Paged (F-1) — a truncated read mis-states variances. */
export async function listStocktakeLines(
  db: StocktakeClient,
  orgId: string,
  sessionId: string,
): Promise<StocktakeLineRow[]> {
  const { data, error } = await fetchAllRows<Row>((from, to) =>
    db
      .from("stocktake_lines")
      .select(STOCKTAKE_LINE_COLUMNS)
      .eq("org_id", orgId) // ACTIVE-ORG PIN
      .eq("session_id", sessionId)
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw readFailure("stocktake: session lines", error);
  return (data ?? []) as unknown as StocktakeLineRow[];
}

export interface StocktakeDetail {
  positions: StocktakeLinePosition[];
  summary: StocktakeSummary;
}

/** Join a session's lines to the catalogue and derive variances. */
export function composeStocktakeDetail(
  lines: readonly StocktakeLineRow[],
  items: ReadonlyMap<string, StocktakeItemRefInput>,
): StocktakeDetail {
  const positions = buildLinePositions(lines, items);
  return { positions, summary: summariseLines(positions) };
}

/**
 * Find one item by a scanned/typed code — barcode OR sku, case-insensitive.
 *
 * ORG-PINNED and LOUD. Used by scan-to-find / scan-to-count: a scanner reads the
 * box, this resolves it to the single catalogue row (or null). `.limit(1)` is an
 * honest bounded read (the unique indexes guarantee at most one match anyway).
 */
export type StocktakeItemLookup = {
  id: string;
  name: string;
  unit: string;
  sku: string | null;
  barcode: string | null;
  active: boolean;
};

export async function findStockItemByCode(
  db: StocktakeClient,
  orgId: string,
  code: string,
): Promise<StocktakeItemLookup | null> {
  const trimmed = code.trim();
  if (!trimmed) return null;
  // Case-insensitive exact match on either identifier. PostgREST `or` with
  // `ilike` — the value is escaped for the filter grammar (commas/parens/stars
  // would otherwise break it, and `*` is a wildcard we do not want here).
  const safe = trimmed.replace(/[(),*]/g, " ");
  const { data, error } = await db
    .from("stock_items")
    .select("id, name, unit, sku, barcode, active")
    .eq("org_id", orgId) // ACTIVE-ORG PIN
    .or(`barcode.ilike.${safe},sku.ilike.${safe}`)
    .limit(1);
  if (error) throw readFailure("stocktake: item by code", error);
  const row = (data ?? [])[0];
  return row ? (row as unknown as StocktakeItemLookup) : null;
}
