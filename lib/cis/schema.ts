import { z } from "zod";

import { SUPPLIER_PAYMENT_METHODS } from "@/lib/suppliers/payments";

import { VAT_TREATMENTS } from "./deduction";
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

// ---------------------------------------------------------------------------
// H2-CIS M3 — the deduction basis and the CIS payment
// ---------------------------------------------------------------------------

const MAX_MONEY = 10_000_000;

/**
 * The CIS details of one supplier bill: what part of it is materials, what the
 * CITB levy took off, and how VAT is treated.
 *
 * `materials_amount` is ONE figure covering everything CIS340 §3.12 removes from
 * the gross — materials the subcontractor paid for directly, consumable stores,
 * fuel EXCEPT for travelling, plant hire, and manufacture/prefabrication. It is
 * never derived: HMRC requires the ACTUAL amounts the subcontractor paid, which
 * only the contractor holding their invoice knows.
 *
 * `citb_levy_amount` is separate rather than lumped in, because CISR15110 takes
 * the levy off the reported "gross amount of payment" itself rather than treating
 * it as a materials cost — and M4's monthly return needs that figure back.
 */
export const cisBillDetailsSchema = z
  .object({
    materials_amount: z.coerce
      .number({ invalid_type_error: "Enter the materials figure, or 0." })
      .min(0, "Materials can't be negative.")
      .max(MAX_MONEY)
      .default(0),
    citb_levy_amount: z.coerce
      .number({ invalid_type_error: "Enter the CITB levy, or 0." })
      .min(0, "The CITB levy can't be negative.")
      .max(MAX_MONEY)
      .default(0),
    vat_treatment: z.enum(VAT_TREATMENTS, {
      errorMap: () => ({ message: "Choose how VAT is treated on this bill." }),
    }),
    /**
     * Only meaningful under the reverse charge, and REQUIRED there: HMRC wants
     * the invoice to state the VAT the customer must account for, or failing that
     * the rate. Constrained to the same domain as `finances.vat_rate` so the two
     * can never disagree about what a legal UK VAT rate is.
     */
    reverse_charge_vat_rate: z
      .preprocess(
        (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
        z.coerce.number().optional(),
      )
      .refine((v) => v === undefined || v === 0 || v === 5 || v === 20, {
        message: "The reverse-charge VAT rate must be 0, 5 or 20.",
      }),
    notes: optionalText(2000),
  })
  .refine(
    (d) => d.vat_treatment !== "reverse_charge" || d.reverse_charge_vat_rate !== undefined,
    {
      path: ["reverse_charge_vat_rate"],
      message: "Say which VAT rate the customer accounts for under the reverse charge.",
    },
  )
  .refine((d) => d.vat_treatment === "reverse_charge" || d.reverse_charge_vat_rate === undefined, {
    path: ["reverse_charge_vat_rate"],
    message: "A reverse-charge rate only applies when the treatment is reverse charge.",
  });

export type CisBillDetailsInput = z.infer<typeof cisBillDetailsSchema>;

/**
 * Recording a CIS payment.
 *
 * NOTE WHAT IS **NOT** AN INPUT: the rate, the basis, the deduction, and the
 * amount withheld. All four are derived server-side from the subcontractor's
 * verification state and the bills, and the database independently recomputes
 * and refuses anything that disagrees. A client cannot post `cis_rate = 20` and
 * have it honoured.
 *
 * `expected_rate` is the one rate-shaped field, and it is an ASSERTION rather
 * than an instruction: if the form was rendered at 20% and a re-verification has
 * since moved the subcontractor to 30%, the write is REFUSED instead of quietly
 * posting at a rate the operator never saw.
 *
 * `allocations` is mandatory and non-empty — a CIS deduction has no basis without
 * a bill. On-account and non-CIS payments keep using `supplierPaymentSchema`.
 */
export const cisPaymentSchema = z.object({
  paid_at: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date the money left your account."),
  method: z.enum(SUPPLIER_PAYMENT_METHODS, {
    errorMap: () => ({ message: "Choose how the payment was made." }),
  }),
  reference: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(120).optional(),
  ),
  notes: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(2000).optional(),
  ),
  expected_rate: z.coerce
    .number()
    .min(0)
    .max(100)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  allocations: z
    .array(
      z.object({
        finance_id: z.string().uuid("Pick a bill to pay."),
        amount: z.coerce
          .number()
          .positive("Each bill line needs an amount above zero.")
          .max(MAX_MONEY),
      }),
    )
    .min(1, "Choose at least one bill — a CIS deduction needs a bill to work from.")
    .max(100),
});

export type CisPaymentInput = z.infer<typeof cisPaymentSchema>;
