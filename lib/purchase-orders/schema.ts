/**
 * Shared validation + constants for the purchase-orders module.
 *
 * Server/client-safe — no server-only imports. Mirrors the quotes vertical:
 * per-line VAT, the same rounding via computeTotals (reused structurally).
 */

import { z } from "zod";

export const PO_STATUSES = ["draft", "sent", "received", "cancelled"] as const;
export type PurchaseOrderStatus = (typeof PO_STATUSES)[number];

/** Legal forward status transitions (cancel is allowed from any live state). */
export const PO_TRANSITIONS: Record<PurchaseOrderStatus, ReadonlyArray<PurchaseOrderStatus>> = {
  draft: ["sent", "cancelled"],
  sent: ["received", "cancelled"],
  received: ["cancelled"],
  cancelled: [],
};

export function canTransitionPo(from: PurchaseOrderStatus, to: PurchaseOrderStatus): boolean {
  return PO_TRANSITIONS[from]?.includes(to) ?? false;
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
    case "received":
      return "Received";
    case "cancelled":
      return "Cancelled";
    default:
      return status;
  }
}
