/**
 * Public API v1 — the invoices read contract (Open-API expansion).
 *
 * This module is the SINGLE authority on what /api/v1/invoices exposes. The
 * public DTO is an EXPLICIT, curated allowlist — never a spread of a raw
 * `invoices` row — mirroring the jobs DTO discipline (lib/public-api/jobs.ts).
 *
 * The exposed money fields (amount, vat_total, total) are the BILLED amounts
 * printed on the invoice the customer already receives — they are exactly what
 * the customer portal shows (app/customer-portal/[token]/invoices/page.tsx:
 * "id, number, status, amount, vat_total, total, due_date, sent_at, paid_at").
 * They are NOT internal cost / margin figures — the `invoices` table has no
 * cost or margin columns at all — so exposing them widens nothing the customer
 * cannot already see about their own invoice.
 *
 * DELIBERATELY EXCLUDED from the invoices row, and why (the leak surface):
 *   - customer_id, job_id,
 *     quote_id                   → internal FKs. The public shape is the
 *                                  invoice DOCUMENT, not the graph of ids that
 *                                  links it; the jobs DTO set the same rule.
 *   - notes                      → internal / operator-only free text.
 *   - org_id                     → the caller's own org is implied by the key;
 *                                  echoing it back adds nothing and invites a
 *                                  client to treat it as a query input.
 *
 * The security test pins the exact field set so a future column cannot ride
 * into the public shape.
 */

/**
 * The exact column list SELECTed for the public DTO. Never `select("*")` — the
 * projection is the contract, and a star would silently widen it.
 */
export const INVOICE_DTO_COLUMNS = [
  "id",
  "number",
  "status",
  "amount",
  "vat_total",
  "total",
  "due_date",
  "sent_at",
  "paid_at",
  "created_at",
  "updated_at",
] as const;

/** The PostgREST column string for an invoices read. */
export const INVOICE_DTO_SELECT = INVOICE_DTO_COLUMNS.join(", ");

/** The raw shape the SELECT above returns (only the allowlisted columns). */
export type InvoiceRowForDto = {
  id: string;
  number: string;
  status: string;
  amount: number;
  vat_total: number;
  total: number | null;
  due_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * The public invoice DTO — the stable v1 field names an integration binds to.
 * Field names are frozen: renaming one is a breaking API change, not a tidy-up.
 */
export type PublicInvoiceDto = {
  id: string;
  number: string;
  status: string;
  /** Net amount billed. */
  amount: number;
  /** VAT charged on the invoice. */
  vat_total: number;
  /** Gross total (amount + VAT), or null if not yet computed. */
  total: number | null;
  due_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Project an invoices row to the public DTO. EXPLICIT field-by-field mapping —
 * no spread, no `{ ...row }` — so an added row column can never leak: it simply
 * is not copied here until someone deliberately adds it (and updates the pin).
 */
export function toPublicInvoiceDto(row: InvoiceRowForDto): PublicInvoiceDto {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    amount: row.amount,
    vat_total: row.vat_total,
    total: row.total,
    due_date: row.due_date,
    sent_at: row.sent_at,
    paid_at: row.paid_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
