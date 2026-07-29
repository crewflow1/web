import { z } from "zod";

/**
 * Material requests — the shared vocabulary and the TypeScript mirror of the
 * lifecycle the database enforces.
 *
 * PURE. No `server-only`, no I/O: the worker form, the office queue, the
 * server actions and the unit suite all import from here, so there is exactly
 * one definition of "what may follow what" on this side of the wire.
 *
 * THE DATABASE IS THE ENFORCER, THIS IS THE MIRROR — the same relationship
 * lib/approvals/state.ts has with 20260730's trigger and
 * lib/purchase-orders/schema.ts has with 20261060's. The graph below is
 * asserted against the SQL by __tests__/security/material-requests.test.ts, so
 * the two cannot drift: a UI that offers a button the database refuses is a
 * worse bug than a missing button.
 */

/** Mirrors the CHECK on material_requests.status (20261066000000). */
export const MATERIAL_REQUEST_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "partially_fulfilled",
  "fulfilled",
  "rejected",
  "cancelled",
] as const;
export type MaterialRequestStatus = (typeof MATERIAL_REQUEST_STATUSES)[number];

/**
 * Mirrors the CHECK on material_requests.priority (20261066000000).
 *
 * Two values, both drawn from the dominant house vocabulary
 * ('low','normal','high','urgent'), so widening later is a pure CHECK change
 * with no value remapping. See the migration header for the product argument.
 */
export const MATERIAL_REQUEST_PRIORITIES = ["normal", "urgent"] as const;
export type MaterialRequestPriority = (typeof MATERIAL_REQUEST_PRIORITIES)[number];

/**
 * THE TRANSITION GRAPH — the exact mirror of tg_material_request_transition
 * (20261067000000).
 *
 * Note what is NOT here: no edge back to 'draft' from anywhere. Once the
 * office has seen the ask, editing it in place would change what was approved;
 * the correction path is cancel-and-raise-a-new-one.
 */
export const MATERIAL_REQUEST_TRANSITIONS: Record<
  MaterialRequestStatus,
  ReadonlyArray<MaterialRequestStatus>
> = {
  draft: ["submitted", "cancelled"],
  submitted: ["approved", "rejected", "cancelled"],
  approved: ["partially_fulfilled", "fulfilled", "cancelled"],
  partially_fulfilled: ["fulfilled", "cancelled"],
  fulfilled: [],
  rejected: [],
  cancelled: [],
};

/** States nothing may leave. */
export const MATERIAL_REQUEST_TERMINAL_STATUSES = [
  "fulfilled",
  "rejected",
  "cancelled",
] as const satisfies readonly MaterialRequestStatus[];

const TERMINAL: ReadonlySet<string> = new Set(MATERIAL_REQUEST_TERMINAL_STATUSES);

export function isTerminalMaterialRequest(status: MaterialRequestStatus): boolean {
  return TERMINAL.has(status);
}

/** Is `from → to` an edge in the graph the database enforces? */
export function canTransitionMaterialRequest(
  from: MaterialRequestStatus,
  to: MaterialRequestStatus,
): boolean {
  return MATERIAL_REQUEST_TRANSITIONS[from].includes(to);
}

/**
 * The two DERIVED statuses. Nothing in the app may write these: they are
 * computed from stock issue movements and applied by the single RPC
 * `advance_material_request_fulfilment` (20261067000000). The database refuses
 * them from any other path, and
 * __tests__/security/material-requests.test.ts pins that no server action
 * names them in a status write.
 */
export const MATERIAL_REQUEST_DERIVED_STATUSES = [
  "partially_fulfilled",
  "fulfilled",
] as const satisfies readonly MaterialRequestStatus[];

const DERIVED: ReadonlySet<string> = new Set(MATERIAL_REQUEST_DERIVED_STATUSES);

export function isDerivedMaterialRequestStatus(status: string): boolean {
  return DERIVED.has(status);
}

/**
 * What a HUMAN may click, given their role and whether the request is theirs.
 *
 * Deliberately NARROWER than the graph: the derived statuses never appear
 * because no button produces them. Mirrors the authorisation half of
 * tg_material_request_transition — offering an action the database will refuse
 * is the failure this function exists to prevent (the `poManualTransitions`
 * precedent).
 */
export function materialRequestActions(
  status: MaterialRequestStatus,
  viewer: { isAdmin: boolean; isOwnRequest: boolean },
): MaterialRequestStatus[] {
  const out: MaterialRequestStatus[] = [];
  if (status === "draft") {
    if (viewer.isOwnRequest || viewer.isAdmin) out.push("submitted", "cancelled");
    return out;
  }
  if (status === "submitted") {
    if (viewer.isAdmin) out.push("approved", "rejected");
    // Pre-approval a requester may withdraw their own ask.
    if (viewer.isOwnRequest || viewer.isAdmin) out.push("cancelled");
    return out;
  }
  if (status === "approved" || status === "partially_fulfilled") {
    // Post-approval, standing it down is an office decision.
    if (viewer.isAdmin) out.push("cancelled");
    return out;
  }
  return out;
}

// ── Labels / display ────────────────────────────────────────────────────────

export const MATERIAL_REQUEST_STATUS_LABEL: Record<MaterialRequestStatus, string> = {
  draft: "Draft",
  submitted: "Awaiting approval",
  approved: "Approved",
  partially_fulfilled: "Part fulfilled",
  fulfilled: "Fulfilled",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

/** Tailwind accents — the house palette used by the PO and snag pills. */
export const MATERIAL_REQUEST_STATUS_CLASS: Record<MaterialRequestStatus, string> = {
  draft: "bg-slate-100 text-slate-600",
  submitted: "bg-blue-100 text-blue-800",
  approved: "bg-indigo-100 text-indigo-800",
  partially_fulfilled: "bg-amber-100 text-amber-800",
  fulfilled: "bg-emerald-100 text-emerald-800",
  rejected: "bg-rose-100 text-rose-800",
  // slate-600, not 400: AA contrast on slate-100 (the PO register's note).
  cancelled: "bg-slate-100 text-slate-600 line-through",
};

export const MATERIAL_REQUEST_PRIORITY_LABEL: Record<MaterialRequestPriority, string> = {
  normal: "Normal",
  urgent: "Urgent",
};

export const MATERIAL_REQUEST_PRIORITY_CLASS: Record<MaterialRequestPriority, string> = {
  normal: "bg-slate-100 text-slate-700",
  urgent: "bg-red-100 text-red-800",
};

export function materialRequestStatusLabel(status: string): string {
  return MATERIAL_REQUEST_STATUS_LABEL[status as MaterialRequestStatus] ?? status;
}

/** Statuses that still want somebody to do something — the queue's default. */
export const MATERIAL_REQUEST_OPEN_STATUSES = [
  "submitted",
  "approved",
  "partially_fulfilled",
] as const satisfies readonly MaterialRequestStatus[];

// ── Form schemas ────────────────────────────────────────────────────────────

const optionalUuid = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().uuid().optional(),
);

const optionalDate = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a real date")
    .optional(),
);

/**
 * One requested material.
 *
 * `description` is required and `stock_item_id` is optional — the free-text
 * path is the PRIMARY one (20261066 header note 1). Somebody on site who needs
 * an odd-size lintel must be able to ask for it without first creating a
 * catalogue item.
 */
export const materialRequestLineSchema = z.object({
  description: z.string().trim().min(1, "Say what you need").max(500),
  qty: z.coerce.number().positive("Quantity must be above zero").max(999999),
  unit: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? "ea" : v),
    z.string().trim().max(20).default("ea"),
  ),
  /**
   * Optional catalogue link. A PLAIN uuid with no database FK — the frozen
   * cross-lane contract (20261066 header note 2). The service validates that
   * it belongs to the active org before writing it, and ONLY when the stock
   * module is present; when it is absent the field is never offered.
   */
  stock_item_id: optionalUuid,
});
export type MaterialRequestLineInput = z.infer<typeof materialRequestLineSchema>;

export const materialRequestFormSchema = z.object({
  job_id: optionalUuid,
  needed_by: optionalDate,
  priority: z.enum(MATERIAL_REQUEST_PRIORITIES).default("normal"),
  notes: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(5000).optional(),
  ),
  lines: z.array(materialRequestLineSchema).min(1, "Add at least one material"),
});
export type MaterialRequestFormInput = z.infer<typeof materialRequestFormSchema>;

/**
 * A rejection needs a reason — enforced by a CHECK constraint in the database
 * (20261066), mirrored here so the operator gets an inline field error instead
 * of a raw constraint violation.
 */
export const materialRequestRejectSchema = z.object({
  rejection_reason: z.string().trim().min(1, "Tell them why — they'll re-submit otherwise").max(1000),
});
