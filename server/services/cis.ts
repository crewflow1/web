import "server-only";

import { createClient } from "@/lib/supabase/server";
import {
  canRecordVerificationOutcome,
  deriveVerificationExpiry,
  isRateConsistent,
  rateForStatus,
  transitionRefusal,
  MANUAL_VERIFICATION_SOURCE,
} from "@/lib/cis/verification";
import { isOutcomeStatus, type CisStatus, type CisSubcontractor } from "@/lib/cis/types";
import type { CisProfileInput, CisVerificationInput } from "@/lib/cis/schema";

/**
 * CIS subcontractor service (M1).
 *
 * Every call runs on the TENANT (user-JWT) client, so `cis_subcontractors`
 * admin-only RLS is the real boundary: a non-admin member reads nothing and
 * writes nothing even if they reach this module directly. The service-role
 * client is deliberately never used here — this table holds tax identifiers,
 * and there is no legitimate reason to bypass RLS to touch it.
 *
 * The actions layer ALSO checks the role, purely so a non-admin gets a sensible
 * message instead of a silent empty result. That app check is a courtesy; it is
 * not the control.
 *
 * `cis_subcontractors` post-dates the generated types in lib/supabase/types.ts,
 * so `.from` is reached through a precise structural cast — the same seam used
 * by suppliers, toolbox talks and blueprint pins.
 */

export type CisResult<T> = { ok: true; data: T } | { ok: false; error: string };

const COLUMNS =
  "org_id, supplier_id, legal_name, trading_name, company_number, utr, " +
  "subcontractor_type, vat_registered, vat_number, cis_status, deduction_rate, " +
  "verification_reference, verified_at, verification_expires_at, verified_by, " +
  "notes, created_by, updated_by, created_at, updated_at";

type Res<T> = { data: T | null; error: { message: string } | null };

type SelectChain = {
  eq: (k: string, v: unknown) => SelectChain;
  maybeSingle: () => Promise<Res<CisSubcontractor>>;
};
type WriteChain = {
  eq: (k: string, v: unknown) => WriteChain;
  select: (cols: string) => { maybeSingle: () => Promise<Res<CisSubcontractor>> };
};
type CisTable = {
  select: (cols: string) => SelectChain;
  insert: (row: Record<string, unknown>) => {
    select: (cols: string) => { maybeSingle: () => Promise<Res<CisSubcontractor>> };
  };
  update: (row: Record<string, unknown>) => WriteChain;
};

type LooseClient = { from: (t: string) => unknown };

async function cisTable(): Promise<CisTable> {
  const supabase = await createClient();
  return (supabase as unknown as LooseClient).from("cis_subcontractors") as CisTable;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The CIS profile for a supplier, or null when there isn't one — OR when the
 * caller isn't an org admin (RLS returns no rows rather than an error). Callers
 * that need to tell those apart must check the role themselves.
 */
export async function getCisProfile(
  orgId: string,
  supplierId: string,
): Promise<CisSubcontractor | null> {
  const table = await cisTable();
  const { data } = await table
    .select(COLUMNS)
    .eq("org_id", orgId)
    .eq("supplier_id", supplierId)
    .maybeSingle();
  return data ?? null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Create or update the identity half of a CIS profile.
 *
 * Deliberately CANNOT touch cis_status, deduction_rate, verification_reference,
 * verified_at or verification_expires_at — verification state moves only through
 * recordVerification / flagForReverification, which run the transition guard. A
 * profile is born `unverified` (the column default), never pre-verified.
 */
export async function upsertCisProfile(
  orgId: string,
  supplierId: string,
  input: CisProfileInput,
  actorId: string,
): Promise<CisResult<CisSubcontractor>> {
  const table = await cisTable();
  const existing = await getCisProfile(orgId, supplierId);

  const identity = {
    legal_name: input.legal_name,
    trading_name: input.trading_name ?? null,
    company_number: input.company_number ?? null,
    utr: input.utr ?? null,
    subcontractor_type: input.subcontractor_type ?? null,
    vat_registered: input.vat_registered,
    vat_number: input.vat_registered ? input.vat_number ?? null : null,
    notes: input.notes ?? null,
    updated_by: actorId,
  };

  if (!existing) {
    const { data, error } = await table
      .insert({ org_id: orgId, supplier_id: supplierId, ...identity, created_by: actorId })
      .select(COLUMNS)
      .maybeSingle();
    if (error || !data) {
      return { ok: false, error: friendly(error?.message, "Couldn't save the CIS details.") };
    }
    return { ok: true, data };
  }

  const { data, error } = await table
    .update(identity)
    .eq("org_id", orgId)
    .eq("supplier_id", supplierId)
    .select(COLUMNS)
    .maybeSingle();
  if (error || !data) {
    return { ok: false, error: friendly(error?.message, "Couldn't save the CIS details.") };
  }
  return { ok: true, data };
}

/**
 * Record the result of a MANUAL HMRC verification.
 *
 * There is NO HMRC integration — an admin verifies out-of-band via HMRC's own
 * service and types the outcome in. Nothing here contacts HMRC and nothing
 * simulates doing so. See the provider seam in lib/cis/verification.ts for how
 * a real integration would attach later.
 *
 * The rate is DERIVED from the recorded status and never accepted from the
 * caller, so a 30% result cannot be filed as a 20% one. The database enforces
 * the same pairing independently (cis_subcontractors_rate_matches_status).
 */
export async function recordVerification(
  orgId: string,
  supplierId: string,
  input: CisVerificationInput,
  actorId: string,
): Promise<CisResult<CisSubcontractor>> {
  const existing = await getCisProfile(orgId, supplierId);
  if (!existing) {
    return { ok: false, error: "Add the subcontractor's CIS details before recording a verification." };
  }
  if (!existing.utr) {
    return {
      ok: false,
      error: "Record the subcontractor's UTR first — HMRC can't verify anyone without one.",
    };
  }

  const next: CisStatus = input.cis_status;
  // NOT canTransition — see canRecordVerificationOutcome. Re-verifying to the
  // SAME status is the commonest CIS action ("re-checked, still 20%") and must
  // be recordable; it carries a new date and reference even though the status
  // is unchanged.
  if (!canRecordVerificationOutcome(existing.cis_status, next) || !isOutcomeStatus(next)) {
    return { ok: false, error: "That isn't a verification result." };
  }

  const rate = rateForStatus(next);
  if (!isRateConsistent(next, rate)) {
    // Unreachable unless rateForStatus and isRateConsistent disagree; refuse
    // rather than write a pair the database would reject anyway.
    return { ok: false, error: "Internal rate mismatch — the verification was not saved." };
  }

  const expires = input.verification_expires_at ?? deriveVerificationExpiry(input.verified_at);
  if (expires && expires < input.verified_at) {
    return { ok: false, error: "The expiry date can't be before the verification date." };
  }

  const table = await cisTable();
  const { data, error } = await table
    .update({
      cis_status: next,
      deduction_rate: rate,
      verification_reference: input.verification_reference ?? null,
      verified_at: input.verified_at,
      verification_expires_at: expires,
      verified_by: actorId,
      updated_by: actorId,
      notes: appendVerificationNote(existing.notes, next, input.verified_at),
    })
    .eq("org_id", orgId)
    .eq("supplier_id", supplierId)
    .select(COLUMNS)
    .maybeSingle();

  if (error || !data) {
    return { ok: false, error: friendly(error?.message, "Couldn't record the verification.") };
  }
  return { ok: true, data };
}

/**
 * Flag a profile as needing re-verification. Clears the derived rate (the DB
 * CHECK requires a null rate for a pre-outcome status), which is the point: an
 * expired verification must stop any downstream deduction from being computed
 * at a stale rate rather than quietly carrying on.
 *
 * The previous verified_at / reference are KEPT as the audit trail of what was
 * once true — only the authority to deduct is withdrawn.
 */
export async function flagForReverification(
  orgId: string,
  supplierId: string,
  actorId: string,
  reason?: string | null,
): Promise<CisResult<CisSubcontractor>> {
  const existing = await getCisProfile(orgId, supplierId);
  if (!existing) return { ok: false, error: "No CIS profile to flag." };

  const refusal = transitionRefusal(existing.cis_status, "verification_required");
  if (refusal) return { ok: false, error: refusal };

  const table = await cisTable();
  const { data, error } = await table
    .update({
      cis_status: "verification_required",
      deduction_rate: null,
      // verified_at / verification_reference deliberately retained (history).
      updated_by: actorId,
      notes: appendNote(
        existing.notes,
        `Flagged for re-verification${reason ? `: ${reason}` : "."}`,
      ),
    })
    .eq("org_id", orgId)
    .eq("supplier_id", supplierId)
    .select(COLUMNS)
    .maybeSingle();

  if (error || !data) {
    return { ok: false, error: friendly(error?.message, "Couldn't flag for re-verification.") };
  }
  return { ok: true, data };
}

// ---------------------------------------------------------------------------

function appendVerificationNote(
  existing: string | null,
  status: CisStatus,
  verifiedAt: string,
): string | null {
  return appendNote(
    existing,
    `[${verifiedAt}] Verification recorded (${MANUAL_VERIFICATION_SOURCE}): ${status}.`,
  );
}

/** Append an audit line to the free-text notes, oldest-first, bounded in size. */
function appendNote(existing: string | null, line: string): string {
  const trimmed = (existing ?? "").trim();
  const next = trimmed ? `${trimmed}\n${line}` : line;
  // The column is unbounded but keep the audit trail from growing without limit.
  return next.length > 2000 ? next.slice(next.length - 2000) : next;
}

/** Never surface a raw Postgres message (it can echo row contents, incl. the UTR). */
function friendly(dbMessage: string | undefined, fallback: string): string {
  if (dbMessage) console.error("[cis] write failed", dbMessage);
  return fallback;
}
