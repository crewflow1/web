import { round2, toPounds } from "@/lib/money";

/**
 * OPERATIONAL STOCK — the movement vocabulary. PURE: no I/O, no server-only
 * imports, unit-tested directly.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE ACCOUNTING BOUNDARY. This module models QUANTITIES MOVING BETWEEN   ║
 * ║  PLACES and nothing else. There is no unit cost, no valuation and no     ║
 * ║  posting anywhere in `lib/stock`, and none of it can reach `finances`.   ║
 * ║                                                                          ║
 * ║  Purchased materials are ALREADY expensed when the supplier's bill is    ║
 * ║  recorded (recordSupplierBill → finances). Issuing 10 boards to Job A    ║
 * ║  records "10 boards moved Depot → Job A" and NO NEW EXPENSE — a second   ║
 * ║  posting would double-count the same spend and inflate cost of sale on   ║
 * ║  every affected job. Stock valuation / COGS-on-issue is CEO decision D1  ║
 * ║  and is UNDECIDED; this milestone is the authorised safe interim.        ║
 * ║  Asserted on source by __tests__/security/operational-stock.test.ts.     ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * `supabase/migrations/20261064000000_stock_movements.sql` is the source of
 * truth for the type vocabulary and the sign rules; everything here mirrors it
 * so the number the app prints and the number the database holds cannot
 * diverge. Quantities use the same 2dp discipline as money (`round2` /
 * `toPounds`) because the columns are numeric(12,2) on both sides — identical
 * to lib/purchase-orders/receiving.ts, so a 12.5 m³ delivery crosses from
 * order to receipt to stock without a rounding fork.
 */

export const MOVEMENT_TYPES = [
  "receipt",
  "issue",
  "transfer_out",
  "transfer_in",
  "adjustment_in",
  "adjustment_out",
  "correction",
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export function isMovementType(v: string): v is MovementType {
  return (MOVEMENT_TYPES as readonly string[]).includes(v);
}

/** What a storeman calls it. */
export const MOVEMENT_TYPE_LABELS: Record<MovementType, string> = {
  receipt: "Received in",
  issue: "Issued out",
  transfer_out: "Transferred out",
  transfer_in: "Transferred in",
  adjustment_in: "Adjusted up",
  adjustment_out: "Adjusted down",
  correction: "Correction",
};

/**
 * The SIGN, for the six types whose direction is a pure function of the type.
 *
 * `correction` is deliberately absent from this map and returns 0 here: its
 * direction depends on the movement it reverses, so the database resolves it
 * once at insert (tg_stock_movements_derive) and STORES it on the row. Callers
 * must read `effect` off the row for a correction — never re-derive it — which
 * is exactly what `movementEffect` below does.
 */
const SIGN: Record<MovementType, number> = {
  receipt: 1,
  transfer_in: 1,
  adjustment_in: 1,
  issue: -1,
  transfer_out: -1,
  adjustment_out: -1,
  correction: 0,
};

export function movementSign(type: MovementType): number {
  return SIGN[type];
}

/** True when the type's direction is knowable from the type alone. */
export function hasDerivableSign(type: MovementType): boolean {
  return SIGN[type] !== 0;
}

/**
 * The signed quantity for one movement row.
 *
 * Prefers the STORED `effect` whenever the row carries one — that is the value
 * the database computed and froze, and for a `correction` it is the only
 * correct answer. Falls back to `sign × qty` for the six derivable types, so a
 * caller that selected fewer columns still folds correctly.
 */
export function movementEffect(row: {
  movement_type: string;
  qty?: number | string | null;
  effect?: number | string | null;
}): number {
  if (row.effect !== undefined && row.effect !== null && row.effect !== "") {
    return round2(toPounds(row.effect));
  }
  if (!isMovementType(row.movement_type)) return 0;
  return round2(movementSign(row.movement_type) * round2(toPounds(row.qty)));
}

/** Inbound / outbound / neither — drives the arrow and the accent colour. */
export function movementDirection(row: {
  movement_type: string;
  effect?: number | string | null;
  qty?: number | string | null;
}): "in" | "out" | "none" {
  const e = movementEffect(row);
  if (e > 0) return "in";
  if (e < 0) return "out";
  return "none";
}

/** "+40" / "−12.5" — the signed quantity as a builder reads it. */
export function formatEffect(row: {
  movement_type: string;
  qty?: number | string | null;
  effect?: number | string | null;
}): string {
  const e = movementEffect(row);
  const abs = Math.abs(e);
  const body = Number.isInteger(abs) ? String(abs) : abs.toFixed(2);
  if (e > 0) return `+${body}`;
  if (e < 0) return `−${body}`;
  return body;
}

/** Quantities are 2dp in the database; trim the noise for display. */
export function formatQuantity(v: number | string | null | undefined): string {
  const n = round2(toPounds(v));
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/**
 * The Tailwind accent for a movement row. Kept beside the labels so a new
 * movement type cannot be added to the vocabulary without a colour.
 */
export const MOVEMENT_TYPE_CLASS: Record<MovementType, string> = {
  receipt: "bg-emerald-100 text-emerald-800",
  transfer_in: "bg-sky-100 text-sky-800",
  adjustment_in: "bg-emerald-50 text-emerald-700",
  issue: "bg-amber-100 text-amber-800",
  transfer_out: "bg-sky-50 text-sky-700",
  adjustment_out: "bg-amber-50 text-amber-700",
  correction: "bg-purple-100 text-purple-800",
};

export function movementTypeLabel(type: string): string {
  return isMovementType(type) ? MOVEMENT_TYPE_LABELS[type] : type;
}
