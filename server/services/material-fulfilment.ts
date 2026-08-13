import "server-only";
import type { IssuedQty } from "@/lib/material-requests/fulfilment";
import { fetchAllRows, type PageResult } from "@/lib/supabase/paginate";

/**
 * THE STOCK SEAM — the one place material requests touch the operational-stock
 * lane, and the only place that knows the lane might not be there.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS AT ALL
 * ═══════════════════════════════════════════════════════════════════════════
 * Fulfilment is DERIVED from stock ISSUE movements carrying a
 * material_request_line_id. There is no `fulfilled` column on
 * material_request_lines, deliberately (20261066): a stored counter and a
 * movement ledger that could ever disagree is how a page ends up lying about
 * whether the site has its cement.
 *
 * The stock lane (stock_items / stock_movements / record_stock_issue) is built
 * CONCURRENTLY and is not on this branch. The frozen cross-lane contract binds
 * exactly ONE thing: stock_movements.material_request_line_id is a plain uuid
 * carrying our line id, with no FK in either direction. Everything else about
 * that table's shape is theirs to change until it merges.
 *
 * So every read here is FEATURE-DETECTED. When the table, the column or the
 * RPC is absent, callers get `stockModulePending: true` — which every surface
 * renders as "stock module pending", never as "0 issued". Those are different
 * claims: one is "we cannot see", the other is "nothing happened". Empty-on-
 * error being indistinguishable from healthy is the exact failure the PGRST201
 * incident shipped for weeks (__tests__/security/postgrest-embed-ambiguity).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE CORRECTION RULE — read this before changing the query
 * ═══════════════════════════════════════════════════════════════════════════
 * A naive `sum(qty) where movement_type = 'issue' and material_request_line_id
 * = X` IS WRONG, and wrong in the dangerous direction (it over-reports).
 *
 * Verified against the stock lane's live local schema on 2026-07-29:
 *   · stock_movements.qty is ALWAYS POSITIVE (CHECK qty > 0). The SIGN lives
 *     in a separate `effect` column. Summing `qty` is therefore correct for
 *     issues, but only because we filter to movement_type = 'issue'.
 *   · A mistake is corrected by record_stock_correction(), which inserts a
 *     SEPARATE movement with movement_type = 'correction' and
 *     corrects_movement_id = <the original>. It does **NOT** copy
 *     material_request_line_id onto the correction row.
 *
 * So a corrected-away issue STILL carries our line id and would still be
 * counted. A request whose only issue was reversed would read "fulfilled"
 * while the site has nothing. We therefore exclude any issue that has been
 * corrected — cheap, because `stock_movements_corrects_uniq` makes it at most
 * one correction per movement.
 *
 * ESCALATED TO THE LEAD: this exclusion is inferred from the stock lane's
 * schema, not from the frozen contract. If that lane later decides corrections
 * SHOULD carry the request line id, this query double-counts the reversal and
 * must be simplified. It is a single query in a single file for exactly that
 * reason.
 */

/** PostgREST / Postgres codes that mean "that lane isn't here yet". */
const ABSENT_CODES = new Set([
  "PGRST205", // Could not find the table '...' in the schema cache
  "PGRST202", // Could not find the function '...' in the schema cache
  "PGRST204", // Could not find the column '...'
  "42P01", // undefined_table
  "42703", // undefined_column
  "42883", // undefined_function
]);

type PgError = { code?: string | null; message?: string | null } | null;

/** Is this error "the stock lane is absent" rather than "the read failed"? */
export function isStockModuleAbsent(error: PgError): boolean {
  if (!error) return false;
  if (error.code && ABSENT_CODES.has(error.code)) return true;
  // Belt and braces: some PostgREST versions report a missing relation with a
  // null code and only a message.
  const m = (error.message ?? "").toLowerCase();
  return (
    m.includes("could not find the table") ||
    m.includes("could not find the function") ||
    m.includes("does not exist")
  );
}

type Res<T> = { data: T[] | null; error: PgError };
type Chain<T> = {
  select: (c: string) => Chain<T>;
  eq: (k: string, v: unknown) => Chain<T>;
  in: (k: string, v: readonly unknown[]) => Chain<T>;
  order: (k: string, opts?: { ascending?: boolean }) => Chain<T>;
  limit: (n: number) => PromiseLike<Res<T>>;
  range: (from: number, to: number) => PromiseLike<Res<T>>;
};
export type StockSeamClient = {
  from: (t: string) => Chain<Record<string, unknown>>;
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: PgError }>;
};

/**
 * The two real callers pass MULTI-request / org-wide line sets in ONE call:
 *   · intelligence.gatherMaterialDemand builds `lines` from ALL open
 *     demand-status requests org-wide (paged) and passes every line id here.
 *   · material-requests.deriveFulfilment is fed a whole list page's lines (up
 *     to MATERIAL_REQUEST_LIST_LIMIT = 500 requests).
 * So the issue/correction sets can EASILY exceed the 1000-row PostgREST cap.
 * A flat `.limit(1000)` therefore returns a NONDETERMINISTIC ≤1000-row subset
 * (no ORDER BY made it worse), under-counting `issued` and over-stating
 * outstanding demand. Both reads are now PAGED in full via fetchAllRows over a
 * stable UNIQUE order (id asc), which is why there is no `.limit` const left.
 *
 * CHUNKING: `.in()` rides in the GET query string, so an org-scale id set can
 * overflow the PostgREST request-line limit (→ 414/400) in one query. We slice
 * the id lists into IN_CHUNK batches and union the paged results — the same
 * shape server/services/bank-sync.ts uses for its dedupe `.in()`.
 */
const IN_CHUNK = 200;

/**
 * Page a `stock_movements` read filtered by an `.in(<column>, ids)` id set, in
 * full and in chunks: each chunk is paged to completion via fetchAllRows, and
 * the results are unioned. Returns the collected rows plus the FIRST error hit
 * (so the caller can preserve its stock-module-absent feature-detection and its
 * refuse-on-real-failure posture, exactly as the single-query form did).
 */
async function readMovementsChunked<T>(
  db: StockSeamClient,
  orgId: string,
  column: string,
  ids: readonly string[],
  select: string,
  narrow: (c: Chain<Record<string, unknown>>) => Chain<Record<string, unknown>>,
): Promise<{ rows: T[]; error: PgError }> {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const batch = ids.slice(i, i + IN_CHUNK);
    const { data, error } = await fetchAllRows<T>(
      (from, to) =>
        narrow(db.from("stock_movements").select(select))
          .eq("org_id", orgId) // ACTIVE-ORG PIN
          .in(column, batch)
          .order("id", { ascending: true }) // stable UNIQUE total order
          .range(from, to) as unknown as PromiseLike<PageResult<T>>,
    );
    rows.push(...(data as T[]));
    if (error) return { rows, error: error as PgError };
  }
  return { rows, error: null };
}

export type IssuedResult = {
  issued: IssuedQty[];
  /** The stock lane could not be reached — `issued` is unknown, not empty. */
  stockModulePending: boolean;
};

/**
 * Summed stock ISSUES against a set of request lines, corrections excluded.
 *
 * EVERY read is pinned to the ACTIVE org as well as filtered by RLS.
 * `current_org_ids()` returns every org the viewer belongs to, so an RLS-only
 * read would blend a dual-org member's two companies' issues onto one
 * request — the defect class closed by #456/#459/#461/#463/#464/#468, which
 * this new surface must not reopen.
 */
export async function readIssuedForLines(
  db: StockSeamClient,
  orgId: string,
  lineIds: readonly string[],
): Promise<IssuedResult> {
  if (lineIds.length === 0) return { issued: [], stockModulePending: false };

  // The issue movements for the WHOLE passed line set — paged in full and
  // chunked over the id list (org-scale sets exceed both the 1000-row cap and
  // the PostgREST URL length). No `.limit`, so no nondeterministic truncation.
  const { rows, error } = await readMovementsChunked<{
    id: string;
    material_request_line_id: string | null;
    qty: number | string | null;
  }>(
    db,
    orgId,
    "material_request_line_id",
    lineIds,
    "id, material_request_line_id, qty",
    (c) => c.eq("movement_type", "issue"),
  );

  if (error) {
    if (isStockModuleAbsent(error)) return { issued: [], stockModulePending: true };
    // A REAL read failure is not "nothing issued" either. Degrading a broken
    // read to zero would silently under-report fulfilment forever.
    console.error("[material-fulfilment] stock movement read failed", error);
    return { issued: [], stockModulePending: true };
  }

  if (rows.length === 0) return { issued: [], stockModulePending: false };

  // THE CORRECTION RULE (see the header). Paged + chunked over the issued id
  // set for the whole request set, same completeness contract as the issues
  // read — a missed correction would OVER-state fulfilment.
  const corrected = new Set<string>();
  const { rows: corrections, error: corrErr } = await readMovementsChunked<{
    corrects_movement_id: string | null;
  }>(
    db,
    orgId,
    "corrects_movement_id",
    rows.map((r) => r.id),
    "corrects_movement_id",
    (c) => c,
  );
  if (corrErr) {
    // We could see the issues but not their reversals — reporting the
    // uncorrected sum here would OVER-state fulfilment, which is the one
    // direction that gets a site left without materials. Refuse to guess.
    if (!isStockModuleAbsent(corrErr)) {
      console.error("[material-fulfilment] correction read failed", corrErr);
    }
    return { issued: [], stockModulePending: true };
  }
  for (const c of corrections) {
    if (c.corrects_movement_id) corrected.add(c.corrects_movement_id);
  }

  const issued: IssuedQty[] = rows
    .filter((r) => r.material_request_line_id && !corrected.has(r.id))
    .map((r) => ({
      material_request_line_id: r.material_request_line_id as string,
      qty: r.qty,
    }));

  return { issued, stockModulePending: false };
}

/**
 * Ask the database to re-derive and (if it has moved) advance the request's
 * status.
 *
 * THE APP NEVER WRITES 'partially_fulfilled' OR 'fulfilled', AND SINCE
 * 20261071 IT NO LONGER SUPPLIES THE QUANTITIES EITHER. It passes two ids and
 * nothing else; the RPC reads the issue movements itself (corrections excluded,
 * the same rule `readIssuedForLines` uses) and decides what they mean.
 *
 * WHY THE `p_fulfilled` ARGUMENT IS GONE. M4 shipped it because, on its own
 * branch, only the app could read a stock schema that was not frozen yet
 * (20261067's seam note). That left a real hole: any member could call the RPC
 * directly with invented quantities and mark their own org's request fulfilled
 * with no issue movement in existence — proven, then closed by 20261071, which
 * DROPPED the 3-argument form rather than leaving it inert.
 *
 * Best-effort by contract: a failure here must never break the read that
 * triggered it. A stale badge is recoverable; a 500 on the job page is not.
 */
export async function advanceMaterialRequestFulfilment(
  db: StockSeamClient,
  orgId: string,
  requestId: string,
): Promise<string | null> {
  try {
    const { data, error } = await db.rpc("advance_material_request_fulfilment", {
      p_request_id: requestId,
      p_org_id: orgId, // ACTIVE-ORG PIN
    });
    if (error) {
      if (!isStockModuleAbsent(error)) {
        console.error("[material-fulfilment] advance failed", error);
      }
      return null;
    }
    return typeof data === "string" ? data : null;
  } catch (e) {
    console.error("[material-fulfilment] advance threw", e);
    return null;
  }
}

/**
 * RE-DERIVE a request's fulfilment from the live stock ledger and, if it has
 * moved, advance its status through the one blessed RPC.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS THE JOIN THE TWO LANES DEFERRED TO RELEASE TIME
 * ═══════════════════════════════════════════════════════════════════════════
 * M4 shipped `advance_material_request_fulfilment` taking a caller-supplied
 * `p_fulfilled` because, on its own branch, only the app could read a stock
 * schema that was not frozen yet (20261067 seam note). Both lanes are now in
 * main, so the derivation moved INTO THE DATABASE (20261071): the RPC sums the
 * real issue movements itself, excluding corrected ones, and this function is
 * the thin trigger for it. That is strictly better than computing the sum here
 * and handing it over — there is now no arrangement of app inputs that can
 * assert a fulfilment position the ledger does not support.
 *
 * WHY THERE IS NO `stockModulePending` GUARD LEFT. There used to be one,
 * because the sum was measured HERE and an unmeasured read must never advance a
 * status. The sum is now measured inside the same transaction as the write, by
 * the database, over tables that 20261071 hard-depends on — so "we could not
 * see the stock lane" is no longer a state this path can be in. If the RPC
 * itself is unreachable the call returns null and advances nothing, which is
 * the same refusal by a shorter route.
 *
 * BEST-EFFORT, and no longer one-directional: the RPC walks a request forward
 * (approved → partially_fulfilled → fulfilled) and, since 20261071, BACK off
 * `fulfilled` when the derivation no longer supports it. A correction that
 * reduces a PARTIALLY-fulfilled request still leaves it `partially_fulfilled`
 * (the request is open and something did happen); a correction that reduces a
 * FULLY-fulfilled one now walks it back rather than leaving the column claiming
 * `fulfilled` for ever. Every surface renders the DERIVED position
 * (computeMaterialFulfilment) either way; the status column is a cache of that
 * truth, and the invariant it now holds is `fulfilled` ⟹ derived position is
 * `full`.
 */
export async function reconcileRequestFulfilment(
  db: StockSeamClient,
  orgId: string,
  requestId: string,
): Promise<string | null> {
  return advanceMaterialRequestFulfilment(db, orgId, requestId);
}

/**
 * Reconcile whatever material request a stock movement was fulfilling — the
 * CORRECTION path's hook.
 *
 * When an issue that carried a material_request_line_id is reversed, the
 * correction row does NOT carry that id (record_stock_correction only writes
 * corrects_movement_id), so the ORIGINAL movement is where the linkage lives.
 * The stock-correction action passes the id of the movement it reversed; we
 * read the line it named, find that line's request, and re-derive. This is the
 * write that makes "the reversal returns the line to outstanding" show up in
 * the request's status, not only on the next page render.
 */
export async function reconcileFulfilmentForMovement(
  db: StockSeamClient,
  orgId: string,
  movementId: string,
): Promise<string | null> {
  const { data, error } = await db
    .from("stock_movements")
    .select("material_request_line_id")
    .eq("org_id", orgId) // ACTIVE-ORG PIN
    .eq("id", movementId)
    .limit(1);
  if (error) {
    if (!isStockModuleAbsent(error)) {
      console.error("[material-fulfilment] reconcile-for-movement: read failed", error);
    }
    return null;
  }
  const lineId = (
    (data ?? [])[0] as { material_request_line_id: string | null } | undefined
  )?.material_request_line_id;
  if (!lineId) return null; // this movement never touched a material request

  const { data: lineRows, error: lineErr } = await db
    .from("material_request_lines")
    .select("material_request_id")
    .eq("org_id", orgId) // ACTIVE-ORG PIN
    .eq("id", lineId)
    .limit(1);
  if (lineErr) {
    console.error("[material-fulfilment] reconcile-for-movement: line lookup failed", lineErr);
    return null;
  }
  const requestId = (
    (lineRows ?? [])[0] as { material_request_id: string | null } | undefined
  )?.material_request_id;
  if (!requestId) return null;

  return reconcileRequestFulfilment(db, orgId, requestId);
}

export type IssueToRequestLineInput = {
  itemId: string;
  siteId: string;
  qty: number;
  requestLineId: string;
  jobId?: string | null;
  notes?: string | null;
};

export type IssueToRequestLineResult =
  | { ok: true; movementId: string; status: string | null }
  | { ok: false; code?: string; message?: string };

/**
 * Issue stock AGAINST a material request line, then advance the request.
 *
 * The generic issueStock action deliberately always sends
 * p_material_request_line_id = null (the frozen contract exercised, and pinned
 * by __tests__/security/operational-stock.test.ts). Fulfilling a REQUEST is a
 * different intent with a different provenance, so it gets its own path — this
 * one — which sets the line id and then reconciles. record_stock_issue keeps
 * every guarantee it already has (the per-(item, site) lock, the negative-stock
 * refusal, the active-org composite FKs); we add only the request advance.
 */
export async function issueStockToRequestLine(
  db: StockSeamClient,
  orgId: string,
  requestId: string,
  input: IssueToRequestLineInput,
): Promise<IssueToRequestLineResult> {
  const { data, error } = await db.rpc("record_stock_issue", {
    p_org_id: orgId, // ACTIVE-ORG PIN
    p_item_id: input.itemId,
    p_site_id: input.siteId,
    p_qty: input.qty,
    p_job_id: input.jobId ?? null,
    p_material_request_line_id: input.requestLineId,
    p_notes: input.notes ?? null,
  });
  if (error || typeof data !== "string") {
    return { ok: false, code: error?.code ?? undefined, message: error?.message ?? undefined };
  }
  // The movement is committed. Re-derive and advance — best-effort, because a
  // stale badge is recoverable but failing the whole action after real stock
  // has moved is not.
  const status = await reconcileRequestFulfilment(db, orgId, requestId);
  return { ok: true, movementId: data, status };
}

/**
 * Does an item id belong to this org's stock catalogue?
 *
 * THE APP-LAYER HALF OF THE DEFERRED-FK DEBT. `material_request_lines.
 * stock_item_id` is a plain uuid with no FK (the frozen contract), so nothing
 * in the database stops a member of org A writing org B's item id. This check
 * is what stands in for that FK at write time.
 *
 * Returns `true` when the stock module is ABSENT — there is no catalogue to
 * violate, and the callers never offer the field in that state anyway. It
 * returns false only for a definite "that id is not yours".
 */
export async function isStockItemInOrg(
  db: StockSeamClient,
  orgId: string,
  stockItemId: string,
): Promise<boolean> {
  const { data, error } = await db
    .from("stock_items")
    .select("id")
    .eq("org_id", orgId) // ACTIVE-ORG PIN — the whole point of this function
    .eq("id", stockItemId)
    .limit(1);
  if (error) {
    if (isStockModuleAbsent(error)) return true;
    console.error("[material-fulfilment] stock item check failed", error);
    return false;
  }
  return (data ?? []).length > 0;
}
