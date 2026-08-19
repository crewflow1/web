/**
 * Public API v1 — the staff roster read contract (Open-API breadth wave).
 *
 * This module is the SINGLE authority on what /api/v1/staff exposes. The public
 * DTO is an EXPLICIT, curated allowlist — never a spread of a raw `memberships`
 * row — mirroring the jobs DTO discipline (lib/public-api/jobs.ts).
 *
 * A staff roster over a PUBLIC KEY is a PII minefield: names, emails and phone
 * numbers of a business's employees are exactly the kind of data a leaked key
 * must not hand out. So this surface is deliberately IDENTITY-FREE — it exposes
 * only the SHAPE of the team (how many members, in what roles, since when), not
 * WHO they are. That is a genuinely useful integration signal (seat counts,
 * role mix) with none of the human PII.
 *
 * DELIBERATELY EXCLUDED from the memberships row (and never joined in), and why:
 *   - user_id                    → the staff member's identity. The jobs DTO
 *                                  excludes assigned_to for exactly this reason;
 *                                  a user id is the join key to a real person and
 *                                  must not ride a public key. Names, emails and
 *                                  phone numbers (on `users`) are never joined.
 *   - org_id                     → implied by the key; echoing it back invites a
 *                                  client to treat it as a query input.
 *
 * The security test pins the exact field set so a future column — or an
 * ill-advised users join — cannot ride into the public shape.
 */

/**
 * The exact column list SELECTed for the public DTO. Never `select("*")` — the
 * projection is the contract, and a star would silently widen it.
 */
export const STAFF_DTO_COLUMNS = ["id", "role", "created_at"] as const;

/** The PostgREST column string for a staff (memberships) read. */
export const STAFF_DTO_SELECT = STAFF_DTO_COLUMNS.join(", ");

/** The raw shape the SELECT above returns (only the allowlisted columns). */
export type StaffRowForDto = {
  id: string;
  role: string;
  created_at: string;
};

/**
 * The public staff DTO — the stable v1 field names an integration binds to.
 * Field names are frozen: renaming one is a breaking API change, not a tidy-up.
 */
export type PublicStaffDto = {
  /** The membership id — an opaque handle, NOT the user's identity. */
  id: string;
  /** The member's role in the organisation (e.g. owner / admin / member). */
  role: string;
  /** When the member joined the organisation. */
  created_at: string;
};

/**
 * Project a memberships row to the public DTO. EXPLICIT field-by-field mapping —
 * no spread, no `{ ...row }` — so an added row column (or a joined identity
 * field) can never leak: it simply is not copied here until someone deliberately
 * adds it (and updates the pin).
 */
export function toPublicStaffDto(row: StaffRowForDto): PublicStaffDto {
  return {
    id: row.id,
    role: row.role,
    created_at: row.created_at,
  };
}
