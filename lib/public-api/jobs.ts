/**
 * Public API v1 — the jobs read contract (Train K / Mission 9).
 *
 * This module is the SINGLE authority on what /api/v1/jobs exposes. The public
 * DTO is an EXPLICIT, curated allowlist — never a spread of a raw `jobs` row.
 * A public, key-authenticated API is a data plane an outside integration sees,
 * so the discipline is the portal's customer-safe DTO discipline: a column
 * lands in the public shape only by being named here, on purpose.
 *
 * DELIBERATELY EXCLUDED from the jobs row, and why (the leak surface):
 *   - ai_summary, notes          → internal / operator-only free text
 *   - assigned_to                → staff identity (PII), not the customer's
 *   - customer_id                → internal FK; a future customers surface owns
 *                                  customer exposure, this one must not leak ids
 *   - org_id                     → the caller's own org is implied by the key;
 *                                  echoing it back adds nothing and invites a
 *                                  client to think it is a query input
 *   - photos                     → storage object paths
 *   - recurring                  → internal scheduling config
 *   - site_address_line1/2,
 *     site_city/county/country    → full street address (PII). Only the coarse
 *                                  `site_postcode` is exposed — enough to place
 *                                  a job on a map, not to doorstep anyone.
 *
 * There are NO cost / margin / price / portal_token columns on `jobs` at all;
 * the allowlist keeps it that way by construction, and the security test pins
 * the exact field set so a future column cannot ride into the public shape.
 */

/**
 * The exact column list SELECTed for the public DTO. Never `select("*")` — the
 * projection is the contract, and a star would silently widen it.
 */
export const JOB_DTO_COLUMNS = [
  "id",
  "status",
  "scheduled_date",
  "site_postcode",
  "created_at",
  "updated_at",
] as const;

/** The PostgREST column string for a jobs read. */
export const JOB_DTO_SELECT = JOB_DTO_COLUMNS.join(", ");

/** The raw shape the SELECT above returns (only the allowlisted columns). */
export type JobRowForDto = {
  id: string;
  status: string;
  scheduled_date: string | null;
  site_postcode: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * The public job DTO — the stable v1 field names an integration binds to.
 * Field names are frozen: renaming one is a breaking API change, not a tidy-up.
 */
export type PublicJobDto = {
  id: string;
  status: string;
  /** ISO date (YYYY-MM-DD) or null if unscheduled. */
  scheduled_date: string | null;
  /** Coarse site location only — postcode, never the full address. */
  site_postcode: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Project a jobs row to the public DTO. EXPLICIT field-by-field mapping — no
 * spread, no `{ ...row }` — so an added row column can never leak: it simply is
 * not copied here until someone deliberately adds it (and updates the pin).
 */
export function toPublicJobDto(row: JobRowForDto): PublicJobDto {
  return {
    id: row.id,
    status: row.status,
    scheduled_date: row.scheduled_date,
    site_postcode: row.site_postcode,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Pagination — bounded, stable, offset-based
// ---------------------------------------------------------------------------

/** Default page size when the caller does not ask for one. */
export const DEFAULT_PAGE_SIZE = 25;
/** Hard ceiling — a caller cannot ask for an unbounded page. */
export const MAX_PAGE_SIZE = 100;

export type Pagination = {
  /** 1-based page number. */
  page: number;
  /** Effective page size after clamping. */
  per_page: number;
};

/**
 * Parse + clamp untrusted `page` / `per_page` query params.
 *
 * Both fail SAFE: anything missing, non-numeric, zero, negative, or fractional
 * collapses to the safe default; an over-large `per_page` is clamped to
 * {@link MAX_PAGE_SIZE} rather than rejected, so a greedy client is bounded,
 * never handed an unbounded scan.
 */
export function parsePagination(
  pageParam: string | null,
  perPageParam: string | null,
): Pagination {
  return {
    page: clampInt(pageParam, 1, 1, Number.MAX_SAFE_INTEGER),
    per_page: clampInt(perPageParam, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE),
  };
}

/** Zero-based [from, to] range for a PostgREST `.range()` call. */
export function rangeFor(pagination: Pagination): { from: number; to: number } {
  const from = (pagination.page - 1) * pagination.per_page;
  // Fetch ONE extra row to decide has_more without a second COUNT query.
  const to = from + pagination.per_page; // inclusive → per_page + 1 rows
  return { from, to };
}

function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) return fallback;
  return n > max ? max : n;
}
