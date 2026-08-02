/**
 * Public API v1 — the quotes read contract (Open-API expansion).
 *
 * This module is the SINGLE authority on what /api/v1/quotes exposes. The
 * public DTO is an EXPLICIT, curated allowlist — never a spread of a raw
 * `quotes` row — mirroring the jobs DTO discipline (lib/public-api/jobs.ts).
 *
 * The exposed money fields (subtotal, vat_total, total) are the CUSTOMER-FACING
 * figures printed on the quote the customer receives and accepts — the totals
 * the customer portal itself renders. They are the price offered, NOT the
 * internal cost breakdown.
 *
 * DELIBERATELY EXCLUDED from the quotes row, and why (the leak surface):
 *   - cost_labour, cost_materials,
 *     cost_misc, cost_subcontractors,
 *     cost_total                 → INTERNAL COST / MARGIN. This is the most
 *                                  sensitive data on the row: it reveals what a
 *                                  job costs the org and therefore its margin.
 *                                  It must NEVER reach a customer-facing surface.
 *   - public_token               → the public-quote ACCESS SECRET (a leaked
 *                                  token lets anyone view/act on the quote).
 *   - accept_signature           → the customer's captured signature (PII).
 *   - approved_by, approved_at,
 *     approval_comment           → internal approval workflow.
 *   - customer_comment,
 *     followup_sent_at,
 *     viewed_at, created_by      → internal CRM / telemetry.
 *   - eot_* fields               → internal extension-of-time negotiation.
 *   - notes, terms               → internal / long-form free text.
 *   - customer_id, job_id,
 *     lead_id, property_id       → internal FKs (the jobs DTO set the same rule).
 *   - org_id                     → implied by the key; echoing it back invites
 *                                  a client to treat it as a query input.
 *
 * The security test pins the exact field set AND the cost-field exclusions so a
 * future column — especially a cost one — cannot ride into the public shape.
 */

/**
 * The exact column list SELECTed for the public DTO. Never `select("*")` — the
 * projection is the contract, and a star would silently widen it AND drag every
 * cost_* column into the response.
 */
export const QUOTE_DTO_COLUMNS = [
  "id",
  "number",
  "status",
  "currency",
  "subtotal",
  "vat_total",
  "total",
  "valid_until",
  "sent_at",
  "accepted_at",
  "declined_at",
  "created_at",
  "updated_at",
] as const;

/** The PostgREST column string for a quotes read. */
export const QUOTE_DTO_SELECT = QUOTE_DTO_COLUMNS.join(", ");

/** The raw shape the SELECT above returns (only the allowlisted columns). */
export type QuoteRowForDto = {
  id: string;
  number: string;
  status: string;
  currency: string;
  subtotal: number;
  vat_total: number;
  total: number;
  valid_until: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  declined_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * The public quote DTO — the stable v1 field names an integration binds to.
 * Field names are frozen: renaming one is a breaking API change, not a tidy-up.
 */
export type PublicQuoteDto = {
  id: string;
  number: string;
  status: string;
  currency: string;
  /** Net price offered (before VAT) — the customer-facing figure. */
  subtotal: number;
  /** VAT on the quote. */
  vat_total: number;
  /** Gross price offered. */
  total: number;
  valid_until: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  declined_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Project a quotes row to the public DTO. EXPLICIT field-by-field mapping — no
 * spread, no `{ ...row }` — so an added row column (a new cost_* especially)
 * can never leak: it simply is not copied here until someone deliberately adds
 * it (and updates the pin).
 */
export function toPublicQuoteDto(row: QuoteRowForDto): PublicQuoteDto {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    currency: row.currency,
    subtotal: row.subtotal,
    vat_total: row.vat_total,
    total: row.total,
    valid_until: row.valid_until,
    sent_at: row.sent_at,
    accepted_at: row.accepted_at,
    declined_at: row.declined_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
