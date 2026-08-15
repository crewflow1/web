/**
 * Shared validation + types for the estimating price-book / rate-library and
 * saved quote templates.
 *
 * Server/client-safe — no server-only imports (imported by the /pricing client
 * forms AND the server actions). Money crosses the FORM in pounds (the £ field
 * the estimator types, matching the quote builder); the server converts to
 * integer pence at the write boundary via lib/money.poundsToPence.
 */

import { z } from "zod";
import { QUOTE_VAT_RATES } from "@/lib/quotes/schema";

export { QUOTE_VAT_RATES };

const optionalString = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(max).optional(),
  );

const vatRate = z.coerce
  .number()
  .refine(
    (v) => (QUOTE_VAT_RATES as readonly number[]).includes(v),
    "VAT rate must be 0, 5, or 20",
  );

/**
 * Price-book item form payload. `unit_price` is in POUNDS here (what the
 * estimator types) — the action converts to integer pence before the write.
 */
export const priceBookItemSchema = z.object({
  code: optionalString(50),
  description: z.string().trim().min(1, "Give the item a description").max(500),
  unit: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? "ea" : v),
    z.string().trim().max(20).default("ea"),
  ),
  unit_price: z.coerce
    .number({ invalid_type_error: "Enter a price" })
    .nonnegative("Price can't be negative")
    .max(99_999_999),
  category: optionalString(100),
  vat_rate: vatRate,
  active: z.preprocess((v) => v === "true" || v === true || v === "on", z.boolean()),
});

export type PriceBookItemInput = z.infer<typeof priceBookItemSchema>;

/**
 * Saved-template form payload. `name` + optional `job_type`; the lines come from
 * an existing quote's persisted line items, so they are not part of THIS schema
 * (the save action reads them from the quote itself, org-pinned).
 */
export const quoteTemplateSchema = z.object({
  name: z.string().trim().min(1, "Give the template a name").max(150),
  job_type: optionalString(100),
  notes: optionalString(2000),
});

export type QuoteTemplateInput = z.infer<typeof quoteTemplateSchema>;

/**
 * A price-book item as offered to the quote-builder picker. Money is in POUNDS
 * (already converted from the stored pence at the server boundary) so the
 * builder — which is pounds-native — populates a line with zero further maths.
 */
export type PriceBookPickerItem = {
  id: string;
  code: string | null;
  description: string;
  unit: string;
  /** Pounds (converted from stored pence). */
  unit_price: number;
  vat_rate: number;
  category: string | null;
};

/**
 * A saved template as offered to the quote-builder "apply" control. `lines` are
 * already pounds-native LineItem shapes, so applying is a pure client setItems —
 * no round-trip, deterministic, mirroring the AI writer's Apply.
 */
export type QuoteTemplateApplyOption = {
  id: string;
  name: string;
  job_type: string | null;
  lines: Array<{
    description: string;
    qty: number;
    unit: string;
    unit_price: number;
    vat_rate: number;
  }>;
};
