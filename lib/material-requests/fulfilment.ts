import { round2, toPounds } from "@/lib/money";
import type { MaterialRequestStatus } from "./schema";

/**
 * Material-request fulfilment position. PURE — no DB, no server-only imports.
 *
 * Deliberately the same shape as `computeReceiving` (lib/purchase-orders/
 * receiving.ts): one `compute*` entry point returning per-line state plus a
 * status, so "requested vs fulfilled" renders exactly as "ordered vs received"
 * does one screen away.
 *
 * WHERE THE NUMBERS COME FROM. Fulfilment is DERIVED from stock ISSUE
 * movements that carry a material_request_line_id — never from a hand-set
 * flag on the line. There is no `fulfilled` column anywhere in 20261066, on
 * purpose: a stored counter and a movement ledger that could ever disagree is
 * how a page ends up lying about whether the site has its cement.
 *
 * The stock lane is a CONCURRENT lane whose tables may not exist yet. The
 * reader (server/services/material-fulfilment.ts) feature-detects it and hands
 * this module an EMPTY issue list when it is absent, which reads as "nothing
 * issued" — so every surface degrades to "stock module pending" rather than to
 * a wrong number.
 *
 * Quantities use the same 2dp discipline as money (round2/toPounds), because
 * material_request_lines.qty is numeric(12,2) — matching
 * purchase_order_line_items.qty and goods_received_lines.qty_received exactly,
 * so 12.5 m³ of concrete crosses request → PO → receipt → issue without a
 * rounding fork.
 */

/** Mirrors public.material_request_state(uuid, jsonb) in 20261067000000. */
export type MaterialFulfilmentState = "none" | "partial" | "full";

export type MaterialRequestLineRow = {
  id: string;
  description: string;
  qty: number | string | null;
  unit?: string | null;
  stock_item_id?: string | null;
  sort_order?: number | null;
};

/** A summed stock ISSUE against one request line. */
export type IssuedQty = {
  material_request_line_id: string;
  qty: number | string | null;
};

export type MaterialLineFulfilment = {
  lineId: string;
  description: string;
  unit: string;
  /** What was asked for. */
  requested: number;
  /**
   * What has been issued, CLAMPED to `requested` — this is the display number.
   * "18 of 20" can never read "25 of 20": a bar past 100% looks like a bug and
   * hides the only question that matters (is anything still outstanding?).
   */
  fulfilled: number;
  /** The RAW issued total, unclamped. Equals `fulfilled` unless over-issued. */
  issued: number;
  /** requested − fulfilled, never negative. */
  outstanding: number;
  /** More was issued than asked for. Surfaced, never silently swallowed. */
  over: boolean;
  /** How much more than requested was issued (0 when not over). */
  overBy: number;
  /** This line is satisfied. */
  complete: boolean;
};

export type MaterialFulfilmentPosition = {
  lines: MaterialLineFulfilment[];
  totalRequested: number;
  /** Sum of the CLAMPED per-line figures — so it can never exceed totalRequested. */
  totalFulfilled: number;
  totalOutstanding: number;
  /** Mirrors material_request_state(): none / partial / full. */
  state: MaterialFulfilmentState;
  /** totalFulfilled / totalRequested as 0–100 (0 when nothing was requested). */
  pct: number;
  /** At least one line was over-issued. */
  hasOverIssue: boolean;
  /** Lines still outstanding. */
  outstandingCount: number;
  /**
   * True when the stock module could not be reached, so `fulfilled` is not a
   * measurement — it is the absence of one. Every surface MUST branch on this
   * rather than rendering "0 of 20 issued", which is a claim we cannot make.
   */
  stockModulePending: boolean;
};

// Same tolerance as computeReceiving — a hundredth of float noise must not
// read as "short" on a line that is actually complete.
const TOL = 0.005;

function qty(v: number | string | null | undefined): number {
  return round2(toPounds(v));
}

/**
 * @param lines  the request's lines
 * @param issued summed stock ISSUE quantities carrying each line's id
 * @param stockModulePending true when the stock seam was unreachable, so
 *        `issued` is "unknown", not "none"
 */
export function computeMaterialFulfilment(input: {
  lines: MaterialRequestLineRow[];
  issued: IssuedQty[];
  stockModulePending?: boolean;
}): MaterialFulfilmentPosition {
  // Multiple issues (different days, different storemen) hit the same line —
  // SUM them, then clamp. Clamping each issue individually would turn two
  // issues of 10 against a line of 20 into "10 of 20".
  const totals = new Map<string, number>();
  for (const i of input.issued) {
    const key = i.material_request_line_id;
    totals.set(key, round2((totals.get(key) ?? 0) + Math.max(0, qty(i.qty))));
  }

  const lines: MaterialLineFulfilment[] = input.lines.map((li) => {
    const requested = qty(li.qty);
    const issued = totals.get(li.id) ?? 0;
    const fulfilled = Math.min(issued, requested);
    return {
      lineId: li.id,
      description: li.description,
      unit: li.unit?.trim() || "ea",
      requested,
      fulfilled,
      issued,
      outstanding: Math.max(0, round2(requested - fulfilled)),
      over: issued > requested + TOL,
      overBy: issued > requested + TOL ? round2(issued - requested) : 0,
      complete: issued >= requested - TOL,
    };
  });

  const sum = (pick: (l: MaterialLineFulfilment) => number) =>
    lines.reduce((acc, l) => round2(acc + pick(l)), 0);

  const totalRequested = sum((l) => l.requested);
  const totalFulfilled = sum((l) => l.fulfilled);
  const anyIssued = sum((l) => l.issued);

  // Mirrors material_request_state() EXACTLY: 'full' only when EVERY line is
  // satisfied. A total that happens to add up is not enough — 100 of line A
  // and 0 of line B is still a part fulfilment, and the clamp above is what
  // stops an over-issue on A papering over a short B.
  let state: MaterialFulfilmentState;
  if (lines.length === 0 || anyIssued <= TOL) state = "none";
  else if (lines.every((l) => l.complete)) state = "full";
  else state = "partial";

  return {
    lines,
    totalRequested,
    totalFulfilled,
    totalOutstanding: sum((l) => l.outstanding),
    state,
    pct: totalRequested > 0 ? Math.round((totalFulfilled / totalRequested) * 100) : 0,
    hasOverIssue: lines.some((l) => l.over),
    outstandingCount: lines.filter((l) => l.outstanding > TOL).length,
    stockModulePending: input.stockModulePending === true,
  };
}

/**
 * The status a request in `current` should now hold, given a derived position —
 * or null when nothing should move.
 *
 * The APP NEVER WRITES THESE VALUES. This function decides whether it is worth
 * CALLING `advance_material_request_fulfilment`, which re-derives server-side
 * and is the only thing the database will accept a fulfilment status from
 * (20261067). Keeping the rule here too means the common "nothing changed"
 * case costs no round trip.
 *
 * IT MUST MIRROR THE DATABASE EXACTLY. Two definitions of "fulfilled" that can
 * drift is the hazard this whole module is built to avoid, so when 20261071
 * taught the RPC to walk a request BACK off `fulfilled`, this followed.
 *
 * Returns null when the stock module is pending: an absent measurement must
 * never be allowed to advance a status.
 */
export function nextFulfilmentStatus(
  current: MaterialRequestStatus,
  position: MaterialFulfilmentPosition,
): MaterialRequestStatus | null {
  if (position.stockModulePending) return null;
  // `fulfilled` HAS a fulfilment position now: it is a cache of a derivation,
  // and a cache that cannot be corrected is a cache that can lie (20261071 §4).
  if (
    current !== "approved" &&
    current !== "partially_fulfilled" &&
    current !== "fulfilled"
  ) {
    return null;
  }
  let target: MaterialRequestStatus =
    position.state === "full"
      ? "fulfilled"
      : position.state === "partial"
        ? "partially_fulfilled"
        : "approved";
  // THE WALK-BACK. A request claiming `fulfilled` whose issues have been
  // reversed must stop claiming it. Both 'none' and 'partial' land on
  // `partially_fulfilled` — "open, and something happened here" — mirroring
  // advance_material_request_fulfilment. The INVARIANT: status = 'fulfilled'
  // implies the derived position is 'full'.
  if (current === "fulfilled" && position.state !== "full") {
    target = "partially_fulfilled";
  }
  if (target === current) return null;
  // Never walk back to `approved`: an issue that has happened cannot un-happen
  // from this side (a stock correction is the other lane's reversal movement,
  // which simply re-derives here).
  if (target === "approved") return null;
  return target;
}

export const MATERIAL_FULFILMENT_STATE_LABEL: Record<MaterialFulfilmentState, string> = {
  none: "Nothing issued",
  partial: "Part fulfilled",
  full: "Fulfilled",
};

/** Quantities are 2dp in the database; trim the noise for display. */
export function formatMaterialQty(v: number | string | null | undefined): string {
  const n = qty(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/**
 * Is this request overdue? Pure so the queue's "overdue" filter and the job
 * panel's red date agree. A request that has been fulfilled, rejected or
 * cancelled is never overdue — nobody is waiting on it.
 */
export function isMaterialRequestOverdue(
  row: { status: string; needed_by: string | null },
  todayIso: string,
): boolean {
  if (!row.needed_by || !todayIso) return false;
  if (row.status === "fulfilled" || row.status === "rejected" || row.status === "cancelled") {
    return false;
  }
  return row.needed_by < todayIso;
}
