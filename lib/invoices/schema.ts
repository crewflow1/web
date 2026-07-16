/**
 * Shared validation + types for the invoices module.
 *
 * Server/client-safe — no server-only imports.
 */

import { z } from "zod";

/**
 * Every status the database enum admits — the READ vocabulary.
 *
 * `overdue` is included because rows and display surfaces can still carry it,
 * but it is NOT writable: it is derived, not stored (lib/invoices/overdue.ts).
 * Use WRITABLE_INVOICE_STATUSES for anything that persists a status.
 */
export const INVOICE_STATUSES = [
  "draft",
  "sent",
  "awaiting_payment",
  "partially_paid",
  "paid",
  "overdue",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * Statuses an operator or import may PERSIST.
 *
 * `overdue` is deliberately absent. It is derived from `due_date` + the
 * trigger-owned payment status, so storing it created a value nothing kept
 * current: a manually-marked invoice stayed "overdue" after being paid, and an
 * unmarked one stayed "sent" 60 days late. Every write path must validate
 * against this list so no new stored-overdue divergence can be created.
 *
 * The enum member itself is retained in the database (see overdue.ts) — old
 * rows may carry it and dropping an enum value is irreversible.
 */
export const WRITABLE_INVOICE_STATUSES = [
  "draft",
  "sent",
  "awaiting_payment",
  "partially_paid",
  "paid",
] as const satisfies readonly InvoiceStatus[];
export type WritableInvoiceStatus = (typeof WRITABLE_INVOICE_STATUSES)[number];

/** Statuses where the invoice is outstanding (operator should chase). */
export const OUTSTANDING_STATUSES: ReadonlyArray<InvoiceStatus> = [
  "sent",
  "awaiting_payment",
  "partially_paid",
  "overdue",
];

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

// Body for POST /api/invoices — generate from a quote
export const createInvoiceSchema = z.object({
  quote_id: z.string().uuid(),
  due_date: optionalDate,
  notes: optionalString(5000),
});

// Body for PATCH /api/invoices/[id] — update mutable fields only.
// amount/vat_total/total/number/quote_id/org_id are NOT patchable here.
// job_id may be set to a UUID or explicitly nulled (unlink).
const optionalJobId = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  z.union([z.string().uuid(), z.null()]).optional(),
);
export const updateInvoiceSchema = z.object({
  // WRITABLE_, not INVOICE_STATUSES: PATCH {status:"overdue"} is now rejected
  // at validation. Overdue is derived, so persisting it could only ever create
  // a value that drifts from the truth.
  status: z.enum(WRITABLE_INVOICE_STATUSES).optional(),
  due_date: optionalDate,
  notes: optionalString(5000),
  job_id: optionalJobId,
});
