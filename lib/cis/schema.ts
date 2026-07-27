import { z } from "zod";

import { CIS_OUTCOME_STATUSES, SUBCONTRACTOR_TYPES } from "./types";
import {
  canonicaliseCompanyNumber,
  canonicaliseUtr,
  canonicaliseVatNumber,
  canonicaliseVerificationReference,
} from "./verification";

/**
 * CIS M1 form schemas. Pure — imported by server actions and tests alike.
 *
 * Identifiers are CANONICALISED here (whitespace stripped, upper-cased) so the
 * value that reaches the database is already in the shape its CHECK constraints
 * expect, and a user typing "12345 67890" is helped rather than rejected.
 */

/** "" → undefined, so an untouched optional input clears rather than fails. */
const optionalText = (max: number) =>
  z.string().trim().max(max).optional().or(z.literal("").transform(() => undefined));

export const cisProfileSchema = z.object({
  legal_name: z
    .string()
    .trim()
    .min(1, "Enter the name HMRC holds for this subcontractor")
    .max(200),
  trading_name: optionalText(200),
  subcontractor_type: z
    .enum(SUBCONTRACTOR_TYPES)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  company_number: z
    .string()
    .trim()
    .optional()
    .or(z.literal("").transform(() => undefined))
    .transform((v) => (v ? canonicaliseCompanyNumber(v) ?? "__invalid__" : undefined))
    .refine((v) => v !== "__invalid__", {
      message: "A company number is 8 digits, or 2 letters then 6 digits (e.g. SC123456).",
    }),
  utr: z
    .string()
    .trim()
    .optional()
    .or(z.literal("").transform(() => undefined))
    .transform((v) => (v ? canonicaliseUtr(v) ?? "__invalid__" : undefined))
    .refine((v) => v !== "__invalid__", {
      message: "A UTR is exactly 10 digits (e.g. 1234567890).",
    }),
  vat_registered: z
    .union([z.literal("on"), z.literal("true"), z.literal("")])
    .optional()
    .transform((v) => v === "on" || v === "true"),
  vat_number: z
    .string()
    .trim()
    .optional()
    .or(z.literal("").transform(() => undefined))
    .transform((v) => (v ? canonicaliseVatNumber(v) ?? "__invalid__" : undefined))
    .refine((v) => v !== "__invalid__", {
      message: "A UK VAT number is 9 or 12 digits, optionally prefixed GB.",
    }),
  notes: optionalText(2000),
});

export type CisProfileInput = z.infer<typeof cisProfileSchema>;

/**
 * Recording a MANUAL verification outcome. The status must be one an HMRC
 * verification can actually return — `unverified` and `verification_required`
 * are not outcomes and cannot be "recorded".
 */
export const cisVerificationSchema = z.object({
  cis_status: z.enum(CIS_OUTCOME_STATUSES, {
    errorMap: () => ({ message: "Choose the result HMRC gave you." }),
  }),
  verification_reference: z
    .string()
    .trim()
    .optional()
    .or(z.literal("").transform(() => undefined))
    .transform((v) => (v ? canonicaliseVerificationReference(v) ?? "__invalid__" : undefined))
    .refine((v) => v !== "__invalid__", {
      message: "An HMRC verification reference is V followed by 10 digits (e.g. V1234567890).",
    }),
  verified_at: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date HMRC verified them."),
  /** Optional operator override of the derived expiry. */
  verification_expires_at: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date.")
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

export type CisVerificationInput = z.infer<typeof cisVerificationSchema>;

/** Flagging a profile for re-verification. No outcome, no date. */
export const cisReverificationSchema = z.object({
  reason: optionalText(500),
});
