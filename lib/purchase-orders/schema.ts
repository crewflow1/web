/**
 * Shared validation + constants for the purchase-orders module.
 *
 * Server/client-safe — no server-only imports. Mirrors the quotes vertical:
 * per-line VAT, the same rounding via computeTotals (reused structurally).
 */

import { z } from "zod";

/**
 * Mirrors the CHECK on purchase_orders.status. `partially_received` was added
 * by migration 20261060000000 together with this list — the two must move as a
 * pair (the fleet 20261057 precedent), or the UI offers a value the database
 * refuses, or the database accepts one the UI cannot label.
 */
export const PO_STATUSES = [
  "draft",
  "sent",
  "partially_received",
  "received",
  "cancelled",
] as const;
export type PurchaseOrderStatus = (typeof PO_STATUSES)[number];

/**
 * Legal MANUAL status transitions — what a human may click (cancel is allowed
 * from any live state).
 *
 * This is deliberately NARROWER than the graph the database enforces
 * (tg_purchase_order_transition, 20261060000000): the receiving engine ALSO
 * moves this column, and voiding a goods received note legitimately walks it
 * BACKWARDS (received → partially_received → sent). Those edges are legal but
 * are not buttons, so they do not belong here.
 */
export const PO_TRANSITIONS: Record<PurchaseOrderStatus, ReadonlyArray<PurchaseOrderStatus>> = {
  draft: ["sent", "cancelled"],
  sent: ["received", "cancelled"],
  partially_received: ["cancelled"],
  received: ["cancelled"],
  cancelled: [],
};

export function canTransitionPo(from: PurchaseOrderStatus, to: PurchaseOrderStatus): boolean {
  return PO_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * THE RULE for the manual `received` tick now that goods received notes exist:
 * receipt state is DERIVED from posted GRNs and may not contradict them.
 *
 *   - No posted GRN on the order → the legacy tick still works exactly as it
 *     does in production today (sent → received). Nothing that works now
 *     stops working, and the POs already sitting at 'received' need no backfill.
 *   - Any posted GRN → the status belongs to the receiving engine. The only
 *     manual move left is 'cancelled'.
 *
 * The database is the enforcer; this function exists so the UI never renders a
 * button the database will refuse.
 */
export function poManualTransitions(
  from: PurchaseOrderStatus,
  hasPostedReceipts: boolean,
): ReadonlyArray<PurchaseOrderStatus> {
  if (!hasPostedReceipts) return PO_TRANSITIONS[from] ?? [];
  return from === "cancelled" ? [] : ["cancelled"];
}

/** A delivery can only be booked against an order the supplier actually has. */
export function canReceiveAgainstPo(status: PurchaseOrderStatus): boolean {
  return status === "sent" || status === "partially_received";
}

export const PO_VAT_RATES = [0, 5, 20] as const;

const optionalString = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(max).optional(),
  );

const optionalDate = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
);

const optionalUuid = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().uuid().optional(),
);

export const poLineItemSchema = z.object({
  description: z.string().trim().min(1, "Line item needs a description").max(500),
  qty: z.coerce.number().positive().max(999999),
  unit: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? "ea" : v),
    z.string().trim().max(20).default("ea"),
  ),
  unit_price: z.coerce.number().nonnegative().max(99_999_999),
  vat_rate: z.coerce
    .number()
    .refine((v) => (PO_VAT_RATES as readonly number[]).includes(v), "VAT rate must be 0, 5, or 20"),
});

export type PoLineItem = z.infer<typeof poLineItemSchema>;

export const purchaseOrderFormSchema = z.object({
  supplier_id: optionalUuid,
  job_id: optionalUuid,
  supplier_reference: optionalString(200),
  expected_date: optionalDate,
  notes: optionalString(5000),
  line_items: z.array(poLineItemSchema).min(1, "Add at least one line item"),
});

export type PurchaseOrderFormInput = z.infer<typeof purchaseOrderFormSchema>;

/** Human label for a status. */
export function poStatusLabel(status: string): string {
  switch (status) {
    case "draft":
      return "Draft";
    case "sent":
      return "Sent";
    case "partially_received":
      return "Part received";
    case "received":
      return "Received";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}
