/**
 * Shared validation for the customers form.
 *
 * Server/client-safe — no server-only imports.
 */

import { z } from "zod";

function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal("").transform(() => undefined));
}

/**
 * Customer classification — business vs individual. Mirrors the DB CHECK on
 * customers.customer_type (migration 20261151000000). Validated here at the
 * write boundary so a crafted payload can't smuggle an unknown type past the
 * form (no mass-assignment): only these two literals ever reach the insert.
 */
export const CUSTOMER_TYPES = ["individual", "business"] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

/** UK VAT number: 9 or 12 digits, optional GB prefix. Same shape as the DB. */
const VAT_NUMBER_RE = /^(GB)?([0-9]{9}|[0-9]{12})$/;
/** Companies House registration: bounded alphanumeric (matches the DB CHECK). */
const COMPANY_NUMBER_RE = /^[A-Za-z0-9]{1,20}$/;

export const customerFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  // Defaults to 'individual' so a legacy/omitted field is always valid, and an
  // unknown value is rejected rather than silently written.
  customer_type: z
    .enum(CUSTOMER_TYPES)
    .optional()
    .transform((v) => v ?? "individual"),
  company_number: z
    .string()
    .trim()
    .max(20)
    .regex(COMPANY_NUMBER_RE, "Letters and numbers only (max 20)")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  vat_number: z
    .string()
    .trim()
    .max(14)
    .regex(
      VAT_NUMBER_RE,
      "UK VAT number: 9 or 12 digits, optional GB prefix",
    )
    .optional()
    .or(z.literal("").transform(() => undefined)),
  // Optional parent business this customer rolls up under. A UUID or nothing;
  // same-org membership is enforced by the composite FK in the DB, and the
  // write action additionally verifies the parent exists in the active org.
  parent_customer_id: z
    .string()
    .trim()
    .uuid()
    .optional()
    .or(z.literal("").transform(() => undefined)),
  email: z
    .string()
    .trim()
    .max(254)
    .email("Doesn't look like a valid email")
    .or(z.literal("").transform(() => undefined))
    .optional(),
  phone: z
    .string()
    .trim()
    .max(50)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  notes: z
    .string()
    .trim()
    .max(5000)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  address_line1: optionalText(200),
  address_line2: optionalText(200),
  city: optionalText(100),
  county: optionalText(100),
  postcode: optionalText(20),
  country: optionalText(100),
});

export type CustomerFormInput = z.infer<typeof customerFormSchema>;
