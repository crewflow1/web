/**
 * Public API v1 — the time-entries read contract (Open-API breadth wave).
 *
 * This module is the SINGLE authority on what /api/v1/time exposes. The public
 * DTO is an EXPLICIT, curated allowlist — never a spread of a raw `time_entries`
 * row — mirroring the jobs DTO discipline (lib/public-api/jobs.ts).
 *
 * A time entry is a labour record: WHEN work happened, and (internally) WHO did
 * it, WHERE, and against WHICH job. Only the WHEN is customer-safe. The public
 * shape is the shift window and its lifecycle timestamps — enough for an
 * integration to reconcile hours, never the surveillance graph around them.
 *
 * DELIBERATELY EXCLUDED from the time_entries row, and why (the leak surface):
 *   - user_id                    → staff identity (PII). The jobs DTO excludes
 *                                  assigned_to for the same reason; a worker's
 *                                  id must not ride a public key.
 *   - job_id                     → internal FK. The public shape is the record,
 *                                  not the graph of ids (the jobs/invoices rule).
 *   - gps_lat, gps_lng           → precise worker LOCATION — the sharpest PII on
 *                                  the row. Never exposed.
 *   - note                       → internal / operator-only free text.
 *   - breaks                     → internal scheduling detail (jsonb).
 *   - payroll_line_id            → internal payroll linkage.
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
export const TIME_DTO_COLUMNS = [
  "id",
  "started_at",
  "ended_at",
  "created_at",
  "updated_at",
] as const;

/** The PostgREST column string for a time-entries read. */
export const TIME_DTO_SELECT = TIME_DTO_COLUMNS.join(", ");

/** The raw shape the SELECT above returns (only the allowlisted columns). */
export type TimeEntryRowForDto = {
  id: string;
  started_at: string;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * The public time-entry DTO — the stable v1 field names an integration binds to.
 * Field names are frozen: renaming one is a breaking API change, not a tidy-up.
 */
export type PublicTimeEntryDto = {
  id: string;
  /** ISO timestamp the shift started. */
  started_at: string;
  /** ISO timestamp the shift ended, or null while still running. */
  ended_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Project a time_entries row to the public DTO. EXPLICIT field-by-field mapping
 * — no spread, no `{ ...row }` — so an added row column can never leak: it
 * simply is not copied here until someone deliberately adds it (and updates the
 * pin).
 */
export function toPublicTimeEntryDto(row: TimeEntryRowForDto): PublicTimeEntryDto {
  return {
    id: row.id,
    started_at: row.started_at,
    ended_at: row.ended_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
