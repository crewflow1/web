import { z } from "zod";

import { SUPPLIER_PAYMENT_METHODS } from "./payments";

/**
 * Phase D — Supplier + expense-draft schemas.
 * H2-CIS M2 — supplier payment (money-out) schemas at the foot of the file.
 *
 * Pure module — imported by both server actions and tests.
 */

export const supplierFormSchema = z.object({
  name: z.string().trim().min(1, "Supplier name is required").max(200),
  phone: z.string().trim().max(50).optional().or(z.literal("").transform(() => undefined)),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email")
    .max(254)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  category: z
    .string()
    .trim()
    .max(80)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  notes: z.string().trim().max(2000).optional().or(z.literal("").transform(() => undefined)),
  // Net payment terms in days (net-30 → 30). OPTIONAL and left undefined when
  // blank, which the action writes as NULL — "terms not recorded", distinct from
  // net-0. The bounds mirror the DB CHECK (0..365, migration 20261088); the
  // 30-day ageing assumption for a null value lives in the read path
  // (lib/commercial/overdue-payables.ts), never here — a form must not stamp an
  // assumed term onto a supplier the operator didn't set.
  payment_terms_days: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce
      .number({ invalid_type_error: "Payment terms must be a number of days." })
      .int("Payment terms must be a whole number of days.")
      .min(0, "Payment terms can't be negative.")
      .max(365, "Payment terms can't be more than 365 days.")
      .optional(),
  ),
});

export type SupplierFormInput = z.infer<typeof supplierFormSchema>;

export const expenseDraftApproveSchema = z.object({
  draft_id: z.string().uuid(),
  supplier_id: z.string().uuid().optional().or(z.literal("").transform(() => undefined)),
  amount: z.coerce.number().min(0).max(10_000_000),
  vat_rate: z.coerce.number().refine((v) => v === 0 || v === 5 || v === 20, "VAT rate must be 0, 5 or 20"),
  category: z.string().trim().max(80).optional().or(z.literal("").transform(() => undefined)),
});

// ---------------------------------------------------------------------------
// H2-CIS M2 — supplier payments (money OUT)
// ---------------------------------------------------------------------------

const MAX_MONEY = 10_000_000;

/**
 * "" → undefined for a genuinely optional text field.
 *
 * NOT the `.optional().or(z.literal("").transform(...))` idiom used above: on an
 * OPTIONAL string that idiom never fires, because `""` already satisfies the
 * first branch, so an untouched input arrives as `""` rather than undefined.
 * That matters here — the double-submit guard matches on
 * `reference is null`, and a `""` written instead of NULL would make every
 * retry look like a new payment. Pre-processing to undefined keeps the column
 * NULL and the guard honest.
 */
const blankToUndefined = (max: number) =>
  z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().trim().max(max).optional(),
  );

/** One line of a payment: which bill (a `finances` row) and how much of it. */
export const supplierAllocationLineSchema = z.object({
  finance_id: z.string().uuid("Pick a bill to pay."),
  amount: z.coerce.number().positive("Each bill line needs an amount above zero.").max(MAX_MONEY),
});

/**
 * Recording a supplier payment.
 *
 * `gross_amount` is what the payment SETTLES; `cis_withheld` is the tax kept
 * back for HMRC; the cash leaving the bank is the difference. `net_paid` is
 * deliberately NOT an input — it is derived in the RPC and re-checked by the DB,
 * so an operator can never key a triple that doesn't add up.
 *
 * Note `gross_amount` allows 0: a nil payment is meaningless in practice but the
 * ledger permits it, and rejecting it here (rather than in the DB) would be the
 * app inventing a rule the database does not hold.
 */
export const supplierPaymentSchema = z
  .object({
    gross_amount: z.coerce
      .number({ invalid_type_error: "Enter the payment amount." })
      .min(0, "The payment amount can't be negative.")
      .max(MAX_MONEY),
    cis_withheld: z.coerce
      .number({ invalid_type_error: "Enter the CIS amount withheld, or 0." })
      .min(0, "CIS withheld can't be negative.")
      .max(MAX_MONEY)
      .default(0),
    paid_at: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the date the money left your account."),
    method: z.enum(SUPPLIER_PAYMENT_METHODS, {
      errorMap: () => ({ message: "Choose how the payment was made." }),
    }),
    reference: blankToUndefined(120),
    notes: blankToUndefined(2000),
    allocations: z.array(supplierAllocationLineSchema).max(100).default([]),
  })
  .refine((d) => d.cis_withheld <= d.gross_amount, {
    path: ["cis_withheld"],
    message: "You can't withhold more than the payment is settling.",
  });

export type SupplierPaymentInput = z.infer<typeof supplierPaymentSchema>;

/**
 * Voiding a payment. A reason is MANDATORY — a void is a correction to a tax
 * record, and an unexplained one is worse than no audit trail at all because it
 * looks deliberate. The DB enforces the same thing
 * (supplier_payments_void_evidenced).
 */
export const voidSupplierPaymentSchema = z.object({
  payment_id: z.string().uuid(),
  void_reason: z
    .string()
    .trim()
    .min(1, "Say why this payment is being voided — it stays on the record.")
    .max(500),
});

export type VoidSupplierPaymentInput = z.infer<typeof voidSupplierPaymentSchema>;
