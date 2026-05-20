/**
 * Shared validation + types for the invoices module.
 *
 * Server/client-safe — no server-only imports.
 */

import { z } from "zod";

export const INVOICE_STATUSES = [
  "draft",
  "sent",
  "awaiting_payment",
  "partially_paid",
  "paid",
  "overdue",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

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
  status: z.enum(INVOICE_STATUSES).optional(),
  due_date: optionalDate,
  notes: optionalString(5000),
  job_id: optionalJobId,
});
