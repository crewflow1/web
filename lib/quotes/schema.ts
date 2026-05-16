/**
 * Shared validation + constants for the quotes module.
 *
 * Server/client-safe — no server-only imports.
 */

import { z } from "zod";

export const QUOTE_STATUSES = [
  "draft",
  "sent",
  "viewed",
  "accepted",
  "declined",
  "expired",
] as const;

export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

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
 * { name, signed_at, ip_hash }. A canvas-based image signature is
 * future polish.
 */
export const publicAcceptSchema = z.object({
  signer_name: z.string().trim().min(1, "Please enter your full name").max(200),
});

export const publicDeclineSchema = z.object({
  reason: optionalString(2000),
});
