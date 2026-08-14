/**
 * Shared validation + constants for the quotes module.
 *
 * Server/client-safe — no server-only imports.
 */

import { z } from "zod";

export const QUOTE_STATUSES = [
  "draft",
  "pending_approval",
  "approved",
  "rejected",
  "sent",
  "viewed",
  "accepted",
  "declined",
  "expired",
] as const;

export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/** Statuses safe to expose on the public /q/<token> portal. */
export const PUBLIC_VISIBLE_STATUSES: ReadonlyArray<QuoteStatus> = [
  "approved",
  "sent",
  "viewed",
  "accepted",
  "declined",
  "expired",
];

/** Statuses from which sendQuote() is allowed to fire. */
export const SENDABLE_STATUSES: ReadonlyArray<QuoteStatus> = ["approved"];

/** Statuses where editing reverts to pending_approval (re-approval required). */
export const APPROVED_OR_BEYOND: ReadonlyArray<QuoteStatus> = [
  "approved",
  "sent",
  "viewed",
];

/** Approval action types — drives the UI form on the quote detail page. */
export const APPROVAL_ACTIONS = ["approve", "reject", "request_changes"] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

export const approvalActionSchema = z.object({
  action: z.enum(APPROVAL_ACTIONS),
  // Required at app-layer for reject + request_changes; optional for approve.
  comment: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(5000).optional(),
  ),
});

export const QUOTE_VAT_RATES = [0, 5, 20] as const;

const optionalString = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(max).optional(),
  );

const optionalDate = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional(),
);

const optionalUuid = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().uuid().optional(),
);

export const lineItemSchema = z.object({
  description: z.string().trim().min(1, "Line item needs a description").max(500),
  qty: z.coerce.number().positive().max(999999),
  unit: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? "ea" : v),
    z.string().trim().max(20).default("ea"),
  ),
  unit_price: z.coerce.number().nonnegative().max(99_999_999),
  vat_rate: z.coerce
    .number()
    .refine(
      (v) => (QUOTE_VAT_RATES as readonly number[]).includes(v),
      "VAT rate must be 0, 5, or 20",
    ),
});

export type LineItem = z.infer<typeof lineItemSchema>;

export const quoteFormSchema = z.object({
  customer_id: z.string().uuid("Pick a customer"),
  property_id: optionalUuid,
  lead_id: optionalUuid,
  valid_until: optionalDate,
  notes: optionalString(5000),
  terms: optionalString(20000),
  line_items: z.array(lineItemSchema).min(1, "Add at least one line item"),
});

export type QuoteFormInput = z.infer<typeof quoteFormSchema>;

/**
 * Public-portal accept/decline payload schema.
 *
 * Signature is stored in quotes.accept_signature jsonb. v1 captures
 * { name, signed_at, ip_hash }. v2 optionally adds a drawn-signature image
 * (stored in the private `signatures` bucket) referenced by storage path.
 *
 * `signature_data_url` is an OPTIONAL canvas PNG data-URL. We only bound its
 * length here (a hard cap so an oversized payload is rejected before any work);
 * the byte-level PNG validation happens server-side in lib/signatures/data-url.
 * A blank field means "typed name only" — acceptance still succeeds.
 */
export const publicAcceptSchema = z.object({
  signer_name: z.string().trim().min(1, "Please enter your full name").max(200),
  comment: optionalString(2000),
  signature_data_url: z
    .string()
    .max(3_000_000, "Signature image is too large")
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
});

export const publicDeclineSchema = z.object({
  reason: optionalString(2000),
  comment: optionalString(2000),
});
