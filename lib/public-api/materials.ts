/**
 * Public API v1 — the materials read contract (Open-API breadth wave).
 *
 * This module is the SINGLE authority on what /api/v1/materials exposes. The
 * public DTO is an EXPLICIT, curated allowlist — never a spread of a raw
 * `material_requests` row — mirroring the jobs DTO discipline
 * (lib/public-api/jobs.ts).
 *
 * A material request is an internal procurement ask with a trigger-governed
 * lifecycle (draft → submitted → approved → fulfilled …, enforced by the DB —
 * see lib/material-requests/schema.ts). This surface is READ-ONLY: the public
 * API never drives that lifecycle. The public shape is the request's identity
 * and current state, enough for an integration to track progress.
 *
 * DELIBERATELY EXCLUDED from the material_requests row, and why (the leak
 * surface):
 *   - job_id                     → internal FK. The public shape is the request,
 *                                  not the graph of ids (the jobs/invoices rule).
 *   - requested_by, decided_by,
 *     created_by                 → staff identity (PII) — the jobs assigned_to
 *                                  rule; a worker/office-hand id must not ride a
 *                                  public key.
 *   - notes, rejection_reason    → internal / operator-only free text.
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
export const MATERIAL_DTO_COLUMNS = [
  "id",
  "number",
  "status",
  "priority",
  "needed_by",
  "submitted_at",
  "decided_at",
  "created_at",
  "updated_at",
] as const;

/** The PostgREST column string for a materials (material_requests) read. */
export const MATERIAL_DTO_SELECT = MATERIAL_DTO_COLUMNS.join(", ");

/** The raw shape the SELECT above returns (only the allowlisted columns). */
export type MaterialRequestRowForDto = {
  id: string;
  number: string;
  status: string;
  priority: string;
  needed_by: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * The public material-request DTO — the stable v1 field names an integration
 * binds to. Field names are frozen: renaming one is a breaking API change.
 */
export type PublicMaterialRequestDto = {
  id: string;
  /** Per-org human reference for the request. */
  number: string;
  /** Lifecycle status (draft / submitted / approved / fulfilled / …). */
  status: string;
  /** Priority (normal / urgent). */
  priority: string;
  /** Date the materials are needed by (YYYY-MM-DD), or null. */
  needed_by: string | null;
  submitted_at: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Project a material_requests row to the public DTO. EXPLICIT field-by-field
 * mapping — no spread, no `{ ...row }` — so an added row column can never leak:
 * it simply is not copied here until someone deliberately adds it (and updates
 * the pin).
 */
export function toPublicMaterialRequestDto(
  row: MaterialRequestRowForDto,
): PublicMaterialRequestDto {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    priority: row.priority,
    needed_by: row.needed_by,
    submitted_at: row.submitted_at,
    decided_at: row.decided_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
