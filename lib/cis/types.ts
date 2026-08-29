/**
 * CIS (Construction Industry Scheme) — shared domain types.
 *
 * PURE. No Supabase, no server-only, no I/O. Safe to import from a client
 * component, a server action, or a test.
 *
 * DOMAIN NOTE — a subcontractor is NOT staff. Staff are `users` + `memberships`
 * and `users.employment_type` is an orthogonal workforce axis. A CIS
 * subcontractor is someone the org PAYS, so the record is a 1:1 extension of a
 * `suppliers` row keyed (org_id, supplier_id). See
 * supabase/migrations/20261046000000_cis_subcontractors.sql.
 */

// ---------------------------------------------------------------------------
// Verification status
// ---------------------------------------------------------------------------

/**
 * The CIS verification lifecycle, modelling real HMRC semantics.
 *
 * HMRC verification returns one of three PAYMENT STATUSES, which is where the
 * deduction rate comes from:
 *   gross       — 0%   the subcontractor holds gross payment status
 *   standard_20 — 20%  registered for CIS, paid net
 *   higher_30   — 30%  not registered / could not be matched
 *
 * Around those sit two pre-outcome states and one recorded failure:
 *   unverified            — never verified. No authority to deduct anything yet.
 *   verification_required — previously verified, now stale (HMRC verification
 *                           expires) or the subcontractor's details changed.
 *   failed                — HMRC returned "unmatched". Per HMRC the HIGHER rate
 *                           then applies, so this carries 30 — but it stays a
 *                           distinct status so the operator can see the 30% came
 *                           from a failed match rather than a clean result.
 */
export const CIS_STATUSES = [
  "unverified",
  "verification_required",
  "gross",
  "standard_20",
  "higher_30",
  "failed",
] as const;

export type CisStatus = (typeof CIS_STATUSES)[number];

export function isCisStatus(v: unknown): v is CisStatus {
  return typeof v === "string" && (CIS_STATUSES as readonly string[]).includes(v);
}

/**
 * Statuses that represent a RECORDED HMRC OUTCOME — they carry a fixed deduction
 * rate and must be evidenced by a verification date (the DB enforces the latter
 * via cis_subcontractors_outcome_dated).
 */
export const CIS_OUTCOME_STATUSES = ["gross", "standard_20", "higher_30", "failed"] as const;

export type CisOutcomeStatus = (typeof CIS_OUTCOME_STATUSES)[number];

export function isOutcomeStatus(status: CisStatus): status is CisOutcomeStatus {
  return (CIS_OUTCOME_STATUSES as readonly string[]).includes(status);
}

/** Short operator-facing labels. */
export const CIS_STATUS_LABELS: Record<CisStatus, string> = {
  unverified: "Not verified",
  verification_required: "Re-verification needed",
  gross: "Gross (0%)",
  standard_20: "Standard (20%)",
  higher_30: "Higher (30%)",
  failed: "Not matched (30%)",
};

/** One line of plain English per status, for the UI. */
export const CIS_STATUS_DESCRIPTIONS: Record<CisStatus, string> = {
  unverified:
    "This subcontractor has not been verified with HMRC. Verify before you pay them — there is no deduction rate until you do.",
  verification_required:
    "A previous verification has expired or their details changed. Re-verify with HMRC before the next payment.",
  gross: "HMRC confirmed gross payment status. Pay in full with no CIS deduction.",
  standard_20: "Registered for CIS. Deduct 20% from the labour element of each payment.",
  higher_30: "Not registered for CIS. Deduct 30% from the labour element of each payment.",
  failed:
    "HMRC could not match this subcontractor. The higher rate of 30% applies until they are matched.",
};

// ---------------------------------------------------------------------------
// Verification source (provenance)
// ---------------------------------------------------------------------------

/**
 * Where the CURRENT verification outcome came from. Mirrors the DB CHECK
 * `cis_subcontractors_verification_source_known` (migration 20261224000000).
 *
 *   manual   — an org admin verified with HMRC out-of-band (CIS online
 *              service / helpline) and typed the result in. The only source
 *              that has ever existed in production.
 *   hmrc_api — recorded by the HMRC online verification adapter
 *              (lib/integrations/hmrc/cis-verify.ts). DARK today: the adapter
 *              refuses without HMRC credentials + the connect flag, so no row
 *              carries this value until activation.
 *
 * Whatever the source, the outcome reaches the row through the SAME write
 * authority (server/services/cis.ts recordVerification) — the source labels
 * the evidence, it never selects a different code path or rate.
 */
export const CIS_VERIFICATION_SOURCES = ["manual", "hmrc_api"] as const;

export type CisVerificationSource = (typeof CIS_VERIFICATION_SOURCES)[number];

export function isCisVerificationSource(v: unknown): v is CisVerificationSource {
  return typeof v === "string" && (CIS_VERIFICATION_SOURCES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Legal form
// ---------------------------------------------------------------------------

export const SUBCONTRACTOR_TYPES = ["sole_trader", "partnership", "company", "trust"] as const;

export type SubcontractorType = (typeof SUBCONTRACTOR_TYPES)[number];

export function isSubcontractorType(v: unknown): v is SubcontractorType {
  return typeof v === "string" && (SUBCONTRACTOR_TYPES as readonly string[]).includes(v);
}

export const SUBCONTRACTOR_TYPE_LABELS: Record<SubcontractorType, string> = {
  sole_trader: "Sole trader",
  partnership: "Partnership",
  company: "Limited company",
  trust: "Trust",
};

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/**
 * A `public.cis_subcontractors` row as the app reads it.
 *
 * `utr` is SENSITIVE. It is admin-only at the RLS layer and must never be
 * rendered unmasked (see maskUtr) nor selected on a customer-portal path.
 */
export type CisSubcontractor = {
  org_id: string;
  supplier_id: string;
  legal_name: string;
  trading_name: string | null;
  company_number: string | null;
  utr: string | null;
  subcontractor_type: SubcontractorType | null;
  vat_registered: boolean;
  vat_number: string | null;
  cis_status: CisStatus;
  /** Percent 0-100. Null only while the status is pre-outcome. Derived from cis_status. */
  deduction_rate: number | null;
  verification_reference: string | null;
  /** Provenance of the current outcome. 'manual' until HMRC activation. */
  verification_source: CisVerificationSource;
  /** ISO date (yyyy-mm-dd). */
  verified_at: string | null;
  /** ISO date (yyyy-mm-dd). */
  verification_expires_at: string | null;
  verified_by: string | null;
  notes: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * How fresh a subcontractor's HMRC verification is, as of a given date.
 *
 *   none          — never verified, or the status is pre-outcome. Do not pay.
 *   expired       — verification has gone stale. Re-verify before paying.
 *   expiring_soon — still valid, but inside the warning window.
 *   current       — good.
 */
export type VerificationFreshness = "none" | "expired" | "expiring_soon" | "current";
