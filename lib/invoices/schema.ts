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

/**
 * Statuses where the invoice has been ISSUED — i.e. sent to the customer and so
 * recognisable as revenue on an accrual basis. Everything except `draft`.
 *
 * `draft` is authoritatively "never issued" (see lib/invoices/overdue.ts): it is
 * the schema DEFAULT and the new-invoice default, so effectively every invoice is
 * a draft carrying real line amounts before it is sent. Counting drafts as revenue
 * overstates profit — and hence the Corporation Tax estimate — for essentially
 * every org, and contradicts the "Invoiced · accrual" basis the tax page declares.
 *
 * There is no `void`/`cancelled` member in this schema (the enum is draft, sent,
 * awaiting_payment, partially_paid, paid, overdue). If one is ever added it must be
 * excluded here too. This is the single accrual-revenue authority every summing
 * caller should read.
 */
export const ISSUED_INVOICE_STATUSES = [
  "sent",
  "awaiting_payment",
  "partially_paid",
  "paid",
  // Legacy stored value — an issued invoice that went unpaid past its due date.
  "overdue",
] as const satisfies readonly InvoiceStatus[];

/** True when the invoice has been issued (any status other than `draft`). */
export function isIssuedStatus(status: string | null | undefined): boolean {
  return (ISSUED_INVOICE_STATUSES as readonly string[]).includes(status ?? "");
}

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
