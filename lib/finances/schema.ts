/**
 * Shared validation + types for the finances module.
 *
 * Used by:
 *   - /api/finances routes (request body parsing)
 *   - finance form components (client-side display + parse error handling)
 *
 * Keep this server/client-safe: no server-only imports here.
 */

import { z } from "zod";

export const FINANCE_VAT_RATES = [0, 5, 20] as const;

export const FINANCE_CATEGORIES = [
  "materials",
  "labor",
  "fuel",
  "subcontractor",
  "tools",
  "office",
  "vehicle",
  "misc",
] as const;

export type FinanceCategory = (typeof FINANCE_CATEGORIES)[number];

const optionalString = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(max).optional(),
  );

const optionalUuid = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().uuid().optional(),
);

const optionalCategory = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.enum(FINANCE_CATEGORIES).optional(),
);

// Numeric coercion so multipart forms (which submit strings) work transparently.
const amountSchema = z.coerce
  .number({ invalid_type_error: "Amount must be a number" })
  .finite()
  .nonnegative("Amount can't be negative")
  .max(99_999_999.99, "Amount is too large");

const vatRateSchema = z.coerce
  .number({ invalid_type_error: "VAT rate must be a number" })
  .refine((v) => (FINANCE_VAT_RATES as readonly number[]).includes(v), {
    message: "VAT rate must be 0, 5, or 20",
  });

export const createFinanceSchema = z.object({
  amount: amountSchema,
  vat_rate: vatRateSchema,
  category: optionalCategory,
  notes: optionalString(5000),
  job_id: optionalUuid,
});

export const updateFinanceSchema = z.object({
  amount: amountSchema.optional(),
  vat_rate: vatRateSchema.optional(),
  category: optionalCategory,
  notes: optionalString(5000),
  job_id: optionalUuid,
});

export const RECEIPT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
export const RECEIPT_ALLOWED_MIME = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "application/pdf",
]);
