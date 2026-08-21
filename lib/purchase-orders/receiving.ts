import { round2, toPounds } from "@/lib/money";

/**
 * Goods-received position for a purchase order (Warehouse M1). PURE — no DB,
 * no server-only imports. Deliberately the same shape as `computePoBilling`:
 * one `compute*` entry point returning totals + a status + a count, so the PO
 * page can render "ordered vs received" exactly as it renders "ordered vs
 * billed".
 *
 * The two are separate axes and must never be conflated:
 *   billing   — has the SUPPLIER INVOICED us? (money; posts to `finances`)
 *   receiving — have the GOODS TURNED UP?     (operations; posts nothing)
 * A delivery can arrive months before its invoice, and vice versa.
 *
 * Quantities use the same 2dp discipline as money (`round2` / `toPounds` from
 * lib/money) because the DB columns are numeric(12,2) on both sides —
 * purchase_order_line_items.qty and goods_received_lines.qty_received. A
 * decimal unit (12.5 m³ of concrete, 2.75 t of ballast) therefore round-trips
 * without drift, and no separate quantity-rounding rule can get out of step
 * with the column definition.
 */

/** Mirrors public.po_receipt_state(uuid) in migration 20261060000000. */
export type PoReceiptStatus = "none" | "partial" | "full";

export type ReceivingOrderedLine = {
  id: string;
  description: string;
  unit?: string | null;
  /** ORDERED quantity — purchase_order_line_items.qty. */
  qty: number | string | null;
  sort_order?: number | null;
};

/** A posted goods_received_lines row (the caller filters to posted GRNs). */
export type ReceivedQty = {
  purchase_order_line_item_id: string;
  qty_received: number | string | null;
};

export type ReceivingLineState = {
  lineId: string;
  description: string;
  unit: string;
  /** What was ordered. */
  ordered: number;
  /** Sum of every POSTED receipt against this line, before this delivery. */
  previouslyReceived: number;
  /** What the operator is entering right now (0 when not receiving this line). */
  receivingNow: number;
  /** previouslyReceived + receivingNow. */
  receivedAfter: number;
  /** Still outstanding BEFORE this delivery — the sensible default to pre-fill. */
  remaining: number;
  /** Still outstanding AFTER this delivery. */
  outstanding: number;
  /** receivedAfter exceeds ordered — the database refuses to post this. */
  over: boolean;
  /** Fully received once this delivery is posted. */
  complete: boolean;
};

export type ReceivingState = {
  lines: ReceivingLineState[];
  totalOrdered: number;
  totalPreviouslyReceived: number;
  totalReceivingNow: number;
  /** Total still outstanding before this delivery. */
  totalRemaining: number;
  /** Receipt state from POSTED receipts only — matches po_receipt_state(). */
  status: PoReceiptStatus;
  /** previouslyReceived / ordered as 0–100 (0 when nothing is ordered). */
  pct: number;
  /** At least one line would exceed its ordered quantity. */
  hasOverReceipt: boolean;
  /** An entered quantity was negative or not a number. */
  hasInvalidEntry: boolean;
  /** Lines with a quantity to post right now. */
  count: number;
};

// Same tolerance as computePoBilling — a penny/hundredth of float noise must
// not read as "short" on a line that is actually complete.
const TOL = 0.005;

function qty(v: number | string | null | undefined): number {
  return round2(toPounds(v));
}

/**
 * @param lines    the PO's ordered line items
 * @param receipts POSTED goods_received_lines rows across every GRN on the PO
 * @param receivingNow optional per-line quantities the operator is entering now
 */
export function computeReceiving(input: {
  lines: ReceivingOrderedLine[];
  receipts: ReceivedQty[];
  receivingNow?: Record<string, number | string | null | undefined>;
}): ReceivingState {
  // Multiple GRNs (and multiple lines within one GRN, historically) can hit the
  // same ordered line — sum them rather than taking the last one.
  const posted = new Map<string, number>();
  for (const r of input.receipts) {
    const key = r.purchase_order_line_item_id;
    posted.set(key, round2((posted.get(key) ?? 0) + qty(r.qty_received)));
  }

  let hasInvalidEntry = false;
  const entered = (lineId: string): number => {
    const raw = input.receivingNow?.[lineId];
    if (raw === undefined || raw === null || raw === "") return 0;
    const n = Number(raw);
    // Not a number, negative, or a return dressed up as a receipt: the database
    // refuses these (qty_received > 0), so the pure model refuses them too
    // rather than silently accepting a value the post would reject.
    if (!Number.isFinite(n) || n < 0) {
      hasInvalidEntry = true;
      return 0;
    }
    return round2(n);
  };

  const lines: ReceivingLineState[] = input.lines.map((li) => {
    const ordered = qty(li.qty);
    const previouslyReceived = posted.get(li.id) ?? 0;
    const receivingNow = entered(li.id);
    const receivedAfter = round2(previouslyReceived + receivingNow);
    return {
      lineId: li.id,
      description: li.description,
      unit: li.unit?.trim() || "ea",
      ordered,
      previouslyReceived,
      receivingNow,
      receivedAfter,
      remaining: Math.max(0, round2(ordered - previouslyReceived)),
      outstanding: Math.max(0, round2(ordered - receivedAfter)),
      over: receivedAfter > ordered + TOL,
      complete: receivedAfter >= ordered - TOL,
    };
  });

  const total = (pick: (l: ReceivingLineState) => number) =>
    lines.reduce((acc, l) => round2(acc + pick(l)), 0);

  const totalOrdered = total((l) => l.ordered);
  const totalPreviouslyReceived = total((l) => l.previouslyReceived);

  // Status mirrors po_receipt_state EXACTLY: 'none' when nothing has been
  // posted at all; 'full' only when EVERY ordered line is satisfied (a total
  // that happens to add up is not enough — 100 of line A and 0 of line B is
  // still a part delivery); 'partial' otherwise.
  let status: PoReceiptStatus;
  if (totalPreviouslyReceived <= TOL) status = "none";
  else if (lines.every((l) => l.previouslyReceived >= l.ordered - TOL)) status = "full";
  else status = "partial";

  return {
    lines,
    totalOrdered,
    totalPreviouslyReceived,
    totalReceivingNow: total((l) => l.receivingNow),
    totalRemaining: total((l) => l.remaining),
    status,
    pct: totalOrdered > 0 ? Math.round((totalPreviouslyReceived / totalOrdered) * 100) : 0,
    hasOverReceipt: lines.some((l) => l.over),
    hasInvalidEntry,
    count: lines.filter((l) => l.receivingNow > 0).length,
  };
}

export const PO_RECEIPT_STATUS_LABEL: Record<PoReceiptStatus, string> = {
  none: "Not received",
  partial: "Part received",
  full: "Received",
};

/** Tailwind accent for the receipt pill — matches the house palette elsewhere. */
export const PO_RECEIPT_STATUS_CLASS: Record<PoReceiptStatus, string> = {
  none: "bg-slate-100 text-slate-700",
  partial: "bg-amber-100 text-amber-800",
  full: "bg-emerald-100 text-emerald-800",
};

/** Quantities are 2dp in the database; trim the noise for display. */
export function formatQty(v: number | string | null | undefined): string {
  const n = qty(v);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}
