/**
 * Public API v1 — the customers read contract (Open-API expansion).
 *
 * This module is the SINGLE authority on what /api/v1/customers exposes. The
 * public DTO is an EXPLICIT, curated allowlist — never a spread of a raw
 * `customers` row — mirroring the jobs DTO discipline (lib/public-api/jobs.ts):
 * a column lands in the public shape only by being named here, on purpose.
 *
 * DELIBERATELY EXCLUDED from the customers row, and why (the leak surface):
 *   - email, phone               → contact PII. A customers directory is
 *                                  org-scoped, but exposing raw contact details
 *                                  over a public API is a distinct product
 *                                  decision; the read surface stays coarse.
 *   - address_line1/2            → full street address (PII). Only the coarse
 *                                  postcode / city / country are exposed —
 *                                  enough to place a customer on a map, not to
 *                                  doorstep anyone (the jobs precedent).
 *   - notes                      → internal / operator-only free text.
 *   - portal_token,
 *     portal_token_expires_at,
 *     portal_token_last_used_at  → the customer-portal ACCESS SECRET and its
 *                                  lifecycle. A leaked portal_token is a login;
 *                                  it must never touch a projection.
 *   - org_id                     → the caller's own org is implied by the key;
 *                                  echoing it back adds nothing and invites a
 *                                  client to think it is a query input.
 *
 * There are NO cost / margin / price columns on `customers`; the allowlist
 * keeps the shape narrow by construction, and the security test pins the exact
 * field set so a future column cannot ride into the public shape.
 */

/**
 * The exact column list SELECTed for the public DTO. Never `select("*")` — the
 * projection is the contract, and a star would silently widen it.
 */
export const CUSTOMER_DTO_COLUMNS = [
  "id",
  "name",
  "city",
  "county",
  "postcode",
  "country",
  "created_at",
  "updated_at",
] as const;

/** The PostgREST column string for a customers read. */
export const CUSTOMER_DTO_SELECT = CUSTOMER_DTO_COLUMNS.join(", ");

/** The raw shape the SELECT above returns (only the allowlisted columns). */
export type CustomerRowForDto = {
  id: string;
  name: string;
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string;
  created_at: string;
  updated_at: string;
};

/**
 * The public customer DTO — the stable v1 field names an integration binds to.
 * Field names are frozen: renaming one is a breaking API change, not a tidy-up.
 */
export type PublicCustomerDto = {
  id: string;
  name: string;
  /** Coarse location only — town/county/postcode/country, never a street. */
  city: string | null;
  county: string | null;
  postcode: string | null;
  country: string;
  created_at: string;
  updated_at: string;
};

/**
 * Project a customers row to the public DTO. EXPLICIT field-by-field mapping —
 * no spread, no `{ ...row }` — so an added row column can never leak: it simply
 * is not copied here until someone deliberately adds it (and updates the pin).
 */
export function toPublicCustomerDto(row: CustomerRowForDto): PublicCustomerDto {
  return {
    id: row.id,
    name: row.name,
    city: row.city,
    county: row.county,
    postcode: row.postcode,
    country: row.country,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
