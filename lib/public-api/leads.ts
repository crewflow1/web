/**
 * Public API v1 — the leads OUTPUT contract (read + write surfaces).
 *
 * Used by BOTH GET /api/v1/leads (list, `read:leads`) and the readback of POST
 * /api/v1/leads (`write:leads`). One allowlist for both, so a lead can never
 * leak more when listed than when created. It follows the same discipline as
 * every other public DTO (lib/public-api/jobs.ts): an EXPLICIT, curated field
 * list — never a spread of a raw `leads` row — and it stays PII-free: the read
 * endpoint deliberately exposes NO contact name/email/phone.
 *
 * DELIBERATELY EXCLUDED, and why (the leak surface):
 *   - contact_name / contact_email / contact_phone → contact PII. The caller
 *                                  supplied these on the request, so echoing
 *                                  them adds nothing; we keep the projection
 *                                  coarse and PII-free to match the read DTOs.
 *   - notes, ai_summary          → internal / operator free text.
 *   - assigned_to                → staff identity (PII).
 *   - customer_id, property_id   → internal FKs (the jobs DTO set the rule).
 *   - org_id                     → implied by the key; echoing it invites a
 *                                  client to treat it as an input.
 */

export const LEAD_DTO_COLUMNS = [
  "id",
  "source",
  "service",
  "status",
  "urgency",
  "estimated_value",
  "postcode",
  "created_at",
  "updated_at",
] as const;

/** The PostgREST column string for a leads readback. */
export const LEAD_DTO_SELECT = LEAD_DTO_COLUMNS.join(", ");

/** The raw shape the SELECT above returns (only the allowlisted columns). */
export type LeadRowForDto = {
  id: string;
  source: string;
  service: string | null;
  status: string;
  urgency: string | null;
  estimated_value: number | null;
  postcode: string | null;
  created_at: string;
  updated_at: string;
};

/** The public lead DTO — the stable v1 field names returned on create. */
export type PublicLeadDto = {
  id: string;
  source: string;
  service: string | null;
  status: string;
  urgency: string | null;
  estimated_value: number | null;
  postcode: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Project a leads row to the public DTO. EXPLICIT field-by-field mapping — no
 * spread — so an added row column (a future contact/PII field especially) can
 * never leak: it is not copied here until someone deliberately adds it.
 */
export function toPublicLeadDto(row: LeadRowForDto): PublicLeadDto {
  return {
    id: row.id,
    source: row.source,
    service: row.service,
    status: row.status,
    urgency: row.urgency,
    estimated_value: row.estimated_value,
    postcode: row.postcode,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
