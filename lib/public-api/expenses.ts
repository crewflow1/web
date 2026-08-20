/**
 * Public API v1 — the expenses read contract (Open-API breadth wave).
 *
 * This module is the SINGLE authority on what /api/v1/expenses exposes. The
 * public DTO is an EXPLICIT, curated allowlist — never a spread of a raw
 * `finances` row — mirroring the jobs DTO discipline (lib/public-api/jobs.ts).
 *
 * `finances` is the money-OUT ledger (a recorded cost: amount + VAT +
 * category). The exposed money fields are the org's OWN recorded expense
 * figures — there is no cost/margin-of-a-third-party or customer PII on the row.
 * `vat_total` is a STORED GENERATED column (amount * vat_rate / 100); it is read
 * here and NEVER written.
 *
 * DELIBERATELY EXCLUDED from the finances row, and why (the leak surface):
 *   - job_id                     → internal FK. The public shape is the expense,
 *                                  not the graph of ids (the jobs/invoices rule).
 *   - supplier_id,
 *     purchase_order_id          → internal supplier-bill linkage (post-dates the
 *                                  base row; added by the supplier-bills wave).
 *   - receipt_url                → a storage-object path under the receipts
 *                                  bucket; never a public handle.
 *   - notes                      → internal / operator-only free text.
 *   - org_id                     → implied by the key; echoing it back invites a
 *                                  client to treat it as a query input.
 *
 * The security test pins the exact field set so a future column cannot ride
 * into the public shape.
 */

/**
 * The exact column list SELECTed for the public DTO. Never `select("*")` — the
 * projection is the contract, and a star would silently widen it.
 */
export const EXPENSE_DTO_COLUMNS = [
  "id",
  "amount",
  "currency",
  "vat_rate",
  "vat_total",
  "category",
  "created_at",
  "updated_at",
] as const;

/** The PostgREST column string for an expenses (finances) read. */
export const EXPENSE_DTO_SELECT = EXPENSE_DTO_COLUMNS.join(", ");

/** The raw shape the SELECT above returns (only the allowlisted columns). */
export type ExpenseRowForDto = {
  id: string;
  amount: number;
  currency: string;
  vat_rate: number;
  vat_total: number | null;
  category: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * The public expense DTO — the stable v1 field names an integration binds to.
 * Field names are frozen: renaming one is a breaking API change, not a tidy-up.
 */
export type PublicExpenseDto = {
  id: string;
  /** Net amount of the expense. */
  amount: number;
  currency: string;
  /** UK VAT rate applied (0, 5 or 20). */
  vat_rate: number;
  /** VAT charged (stored generated column), or null. */
  vat_total: number | null;
  /** Free-text category (materials / labour / fuel / …), or null. */
  category: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Project a finances row to the public DTO. EXPLICIT field-by-field mapping —
 * no spread, no `{ ...row }` — so an added row column can never leak: it simply
 * is not copied here until someone deliberately adds it (and updates the pin).
 */
export function toPublicExpenseDto(row: ExpenseRowForDto): PublicExpenseDto {
  return {
    id: row.id,
    amount: row.amount,
    currency: row.currency,
    vat_rate: row.vat_rate,
    vat_total: row.vat_total,
    category: row.category,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
