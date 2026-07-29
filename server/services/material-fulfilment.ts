import "server-only";
import type { IssuedQty } from "@/lib/material-requests/fulfilment";

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
  limit: (n: number) => PromiseLike<Res<T>>;
};
export type StockSeamClient = {
  from: (t: string) => Chain<Record<string, unknown>>;
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: PgError }>;
};

/** Bound the read — a single request's lines cannot plausibly draw more. */
const MOVEMENT_LIMIT = 2000;

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

  const { data, error } = await db
    .from("stock_movements")
    .select("id, material_request_line_id, qty")
    .eq("org_id", orgId) // ACTIVE-ORG PIN
    .eq("movement_type", "issue")
    .in("material_request_line_id", lineIds)
    .limit(MOVEMENT_LIMIT);

  if (error) {
    if (isStockModuleAbsent(error)) return { issued: [], stockModulePending: true };
    // A REAL read failure is not "nothing issued" either. Degrading a broken
    // read to zero would silently under-report fulfilment forever.
    console.error("[material-fulfilment] stock movement read failed", error);
    return { issued: [], stockModulePending: true };
  }

  const rows = (data ?? []) as Array<{
    id: string;
    material_request_line_id: string | null;
    qty: number | string | null;
  }>;
  if (rows.length === 0) return { issued: [], stockModulePending: false };

  // THE CORRECTION RULE (see the header). One extra query for the whole set.
  const corrected = new Set<string>();
  const { data: corrections, error: corrErr } = await db
    .from("stock_movements")
    .select("corrects_movement_id")
    .eq("org_id", orgId) // ACTIVE-ORG PIN
    .in(
      "corrects_movement_id",
      rows.map((r) => r.id),
    )
    .limit(MOVEMENT_LIMIT);
  if (corrErr) {
    // We could see the issues but not their reversals — reporting the
    // uncorrected sum here would OVER-state fulfilment, which is the one
    // direction that gets a site left without materials. Refuse to guess.
    if (!isStockModuleAbsent(corrErr)) {
      console.error("[material-fulfilment] correction read failed", corrErr);
    }
    return { issued: [], stockModulePending: true };
  }
  for (const c of (corrections ?? []) as Array<{ corrects_movement_id: string | null }>) {
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
 * THE APP NEVER WRITES 'partially_fulfilled' OR 'fulfilled'. This RPC is the
 * only writer the database will accept them from (20261067's transition
 * trigger refuses both from any other path), and the RPC — not this caller —
 * decides which of them the quantities mean. We supply quantities; it supplies
 * the verdict.
 *
 * Best-effort by contract: a failure here must never break the read that
 * triggered it. A stale badge is recoverable; a 500 on the job page is not.
 */
export async function advanceMaterialRequestFulfilment(
  db: StockSeamClient,
  orgId: string,
  requestId: string,
  issued: readonly IssuedQty[],
): Promise<string | null> {
  try {
    const { data, error } = await db.rpc("advance_material_request_fulfilment", {
      p_request_id: requestId,
      p_org_id: orgId,
      p_fulfilled: issued.map((i) => ({
        line_id: i.material_request_line_id,
        qty: Number(i.qty ?? 0),
      })),
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
 * main, so the honest sum is available — and it is computed HERE, by
 * `readIssuedForLines`, which is the corrections-EXCLUDING derivation
 * (record_stock_correction does not copy material_request_line_id, so a naive
 * sum over movement_type='issue' over-reports a reversed issue). We read the
 * real movements and hand the RPC the truth; the RPC still owns the status
 * ARITHMETIC and the security marker. No parallel path, no hand-set status.
 *
 * BEST-EFFORT, and deliberately one-directional in effect: the RPC only walks
 * a request FORWARD (approved → partially_fulfilled → fulfilled) and treats
 * `fulfilled` as terminal (20261067). So a correction that reduces a
 * PARTIALLY-fulfilled request re-derives to a lower position but the status
 * stays `partially_fulfilled` rather than reverting to `approved` — which is
 * correct: the request is still open, and every SURFACE renders the DERIVED
 * position (computeMaterialFulfilment), which is always the live truth. The
 * status column is a forward-only cache of that truth, never its source.
 *
 * An UNMEASURED read (stock module pending / a real read failure) returns null
 * and advances NOTHING: a stale-forward badge is recoverable, a false
 * 'fulfilled' leaves a site without its materials.
 */
export async function reconcileRequestFulfilment(
  db: StockSeamClient,
  orgId: string,
  requestId: string,
): Promise<string | null> {
  // This request's line ids, ACTIVE-ORG pinned. current_org_ids() admits every
  // org the caller belongs to; the pin narrows it to the company being worked
  // in, so a dual-org member cannot reconcile the other company's request.
  const { data, error } = await db
    .from("material_request_lines")
    .select("id")
    .eq("org_id", orgId) // ACTIVE-ORG PIN
    .eq("material_request_id", requestId)
    .limit(MOVEMENT_LIMIT);
  if (error) {
    console.error("[material-fulfilment] reconcile: line read failed", error);
    return null;
  }
  const lineIds = ((data ?? []) as Array<{ id: string | null }>)
    .map((r) => r.id)
    .filter((id): id is string => typeof id === "string");
  if (lineIds.length === 0) return null;

  const { issued, stockModulePending } = await readIssuedForLines(db, orgId, lineIds);
  // An absent or failed measurement must NEVER advance a status. This is the
  // same refusal computeMaterialFulfilment makes on the read side.
  if (stockModulePending) return null;

  return advanceMaterialRequestFulfilment(db, orgId, requestId, issued);
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
