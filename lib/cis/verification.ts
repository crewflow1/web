/**
 * CIS verification — the status/rate authority, the transition guard, expiry
 * derivation, and identifier canonicalisation + masking.
 *
 * PURE. No Supabase, no `server-only`, no clock reads, no I/O — every function
 * that needs "today" takes it as an argument so the behaviour is testable and
 * deterministic. Mirrors lib/staff/secrets.ts for the sensitive-identifier
 * handling (canonicalise on write, mask on display, never encrypt-and-pretend).
 *
 * THE RULE THIS FILE ENFORCES: the STATUS is the authority and the deduction
 * rate is a function of it. A rate is never chosen independently. The same
 * invariant is enforced in the database by cis_subcontractors_rate_matches_status
 * (a CHECK) plus tg_cis_rate_authority (a BEFORE trigger) — this module is the
 * app-side half so the UI can refuse early with a good message, not the only
 * line of defence.
 */

import {
  isOutcomeStatus,
  type CisStatus,
  type VerificationFreshness,
} from "./types";

// ---------------------------------------------------------------------------
// Status → rate authority
// ---------------------------------------------------------------------------

/**
 * The deduction rate implied by a CIS status, as a percentage.
 *
 *   gross        →  0   (gross payment status)
 *   standard_20  → 20   (registered, net payment)
 *   higher_30    → 30   (not registered)
 *   failed       → 30   (HMRC could not match ⇒ the higher rate applies)
 *   unverified / verification_required → null
 *
 * Null is deliberate and load-bearing: before a verification outcome exists
 * there is NO lawful rate to deduct at, and the caller must be forced to deal
 * with that rather than silently defaulting to 20% or 30%.
 */
export function rateForStatus(status: CisStatus): number | null {
  switch (status) {
    case "gross":
      return 0;
    case "standard_20":
      return 20;
    case "higher_30":
      return 30;
    case "failed":
      return 30;
    case "unverified":
    case "verification_required":
      return null;
  }
}

/**
 * True when a (status, rate) pair is self-consistent. Mirrors the DB CHECK,
 * including its treatment of null: a determinate status with a null rate is
 * INCONSISTENT, not "unset".
 */
export function isRateConsistent(status: CisStatus, rate: number | null | undefined): boolean {
  const expected = rateForStatus(status);
  if (expected === null) return rate === null || rate === undefined;
  if (rate === null || rate === undefined) return false;
  return Number(rate) === expected;
}

// ---------------------------------------------------------------------------
// Transition guard
// ---------------------------------------------------------------------------

/**
 * Which statuses a profile may move to from each status.
 *
 * The one hard rule: NOTHING may return to `unverified`. Once a verification has
 * been attempted, that history is real — a stale or failed result becomes
 * `verification_required` or `failed`, never "we never looked". Erasing the
 * attempt would let an operator quietly drop an inconvenient higher-rate result.
 *
 * Everything else is permitted, because a re-verification can legitimately
 * return any outcome, and an operator can always flag a profile for
 * re-verification (details changed, HMRC letter received, expiry passed).
 * Self-transitions are refused — they are no-ops, and treating one as a real
 * change would stamp a fresh verified_at onto an old result.
 */
const ALLOWED_TRANSITIONS: Record<CisStatus, readonly CisStatus[]> = {
  unverified: ["verification_required", "gross", "standard_20", "higher_30", "failed"],
  verification_required: ["gross", "standard_20", "higher_30", "failed"],
  gross: ["verification_required", "standard_20", "higher_30", "failed"],
  standard_20: ["verification_required", "gross", "higher_30", "failed"],
  higher_30: ["verification_required", "gross", "standard_20", "failed"],
  failed: ["verification_required", "gross", "standard_20", "higher_30"],
};

export function allowedTransitions(from: CisStatus): readonly CisStatus[] {
  return ALLOWED_TRANSITIONS[from];
}

/**
 * Whether a fresh HMRC verification RESULT may be recorded over the current
 * status. This is deliberately NOT canTransition.
 *
 * Recording a verification is not a status change — it is evidence arriving. Its
 * most common real-world form is "re-verified, still 20%", which is a
 * same-status write carrying a NEW date and reference. canTransition refuses
 * self-transitions (correctly: a pure status change to itself is a no-op that
 * would restamp an old result), so routing verification through it would make
 * the single most frequent CIS admin action impossible.
 *
 * Any of the four HMRC outcomes is legitimate from any starting point, so the
 * only rule is that the recorded value must actually BE an outcome — a
 * verification can never yield "unverified" or "needs re-verification".
 */
export function canRecordVerificationOutcome(_current: CisStatus, outcome: CisStatus): boolean {
  return isOutcomeStatus(outcome);
}

export function canTransition(from: CisStatus, to: CisStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Why a transition was refused, for the operator. Null when it is allowed. */
export function transitionRefusal(from: CisStatus, to: CisStatus): string | null {
  if (canTransition(from, to)) return null;
  if (from === to) return "That is already the current status.";
  if (to === "unverified") {
    return "A subcontractor can't go back to 'not verified' once a verification has been recorded. Flag them for re-verification instead.";
  }
  return "That status change isn't allowed from here.";
}

// ---------------------------------------------------------------------------
// UK tax-year arithmetic + verification expiry
// ---------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

type YMD = { y: number; m: number; d: number };

/** Strict yyyy-mm-dd parse. Returns null for anything else (including junk dates). */
function parseIsoDate(value: string | null | undefined): YMD | null {
  if (!value) return null;
  const m = ISO_DATE.exec(value.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Reject impossible days (31 Feb etc.) by round-tripping through UTC.
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return { y, m: mo, d };
}

function utcMillis(ymd: YMD): number {
  return Date.UTC(ymd.y, ymd.m - 1, ymd.d);
}

/**
 * The starting calendar year of the UK tax year containing `date`.
 * The UK tax year runs 6 April → 5 April, so 2026-04-05 is in tax year 2025/26
 * (start year 2025) and 2026-04-06 is in 2026/27 (start year 2026).
 */
export function taxYearStart(date: string): number | null {
  const p = parseIsoDate(date);
  if (!p) return null;
  const onOrAfterApril6 = p.m > 4 || (p.m === 4 && p.d >= 6);
  return onOrAfterApril6 ? p.y : p.y - 1;
}

/**
 * When an HMRC verification goes stale.
 *
 * HMRC's rule is that you need not re-verify a subcontractor you have included
 * on a CIS return in the CURRENT tax year or the PREVIOUS TWO tax years. So a
 * verification obtained in tax year Y is good through the end of tax year Y+2 —
 * that is, 5 April of calendar year Y+3.
 *
 *   verified 2026-07-01 → tax year 2026/27 → good through 2029-04-05
 *   verified 2026-04-05 → tax year 2025/26 → good through 2028-04-05
 *
 * This is the DERIVED default. The stored `verification_expires_at` column may
 * be overridden by the operator (e.g. a shorter internal policy), and the
 * freshness check below always prefers the stored value.
 */
export function deriveVerificationExpiry(verifiedAt: string | null | undefined): string | null {
  if (!verifiedAt) return null;
  const start = taxYearStart(verifiedAt);
  if (start === null) return null;
  return `${start + 3}-04-05`;
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
function daysBetween(from: YMD, to: YMD): number {
  return Math.round((utcMillis(to) - utcMillis(from)) / 86_400_000);
}

/** How long before expiry we start nagging the operator to re-verify. */
export const REVERIFICATION_WARNING_DAYS = 60;

export type VerificationSnapshot = {
  cis_status: CisStatus;
  verified_at: string | null;
  verification_expires_at: string | null;
};

/**
 * How fresh a verification is as of `asOf` (an ISO yyyy-mm-dd date).
 *
 * Boundary: a verification is valid THROUGH its expiry date inclusive, so it is
 * `expired` only once `asOf` is strictly after it. A pre-outcome status, or an
 * outcome with no verification date, is `none` — never "current".
 */
export function verificationFreshness(
  snapshot: VerificationSnapshot,
  asOf: string,
): VerificationFreshness {
  if (!isOutcomeStatus(snapshot.cis_status)) return "none";

  const verified = parseIsoDate(snapshot.verified_at);
  if (!verified) return "none";

  const expiryIso = snapshot.verification_expires_at ?? deriveVerificationExpiry(snapshot.verified_at);
  const expiry = parseIsoDate(expiryIso);
  const today = parseIsoDate(asOf);
  if (!expiry || !today) return "none";

  const remaining = daysBetween(today, expiry);
  if (remaining < 0) return "expired";
  if (remaining <= REVERIFICATION_WARNING_DAYS) return "expiring_soon";
  return "current";
}

/**
 * True when this subcontractor must be re-verified before they are paid.
 * Fail-closed: anything we cannot positively confirm as current is stale.
 */
export function isVerificationStale(snapshot: VerificationSnapshot, asOf: string): boolean {
  const freshness = verificationFreshness(snapshot, asOf);
  return freshness === "none" || freshness === "expired";
}

/**
 * PASSTHROUGH — the question the HMRC verification adapter (and its UI) asks,
 * answered by the ONE existing staleness authority rather than a re-derivation.
 *
 * "Needs re-verification" is exactly "the current verification is stale" as the
 * 20261175 stale-verification gate defines it (the DB twin enforces the same
 * rule on every payment allocation). This alias exists so the G5 adapter code
 * reads as intent ("does this profile need re-verifying before HMRC is asked /
 * before payment?") while there remains a single place the boundary logic
 * lives. Deliberately NOT a second implementation.
 */
export function needsReverification(snapshot: VerificationSnapshot, asOf: string): boolean {
  return isVerificationStale(snapshot, asOf);
}

// ---------------------------------------------------------------------------
// Identifiers — canonicalise on write, mask on display
// ---------------------------------------------------------------------------

const UTR_REGEX = /^[0-9]{10}$/;

/**
 * Validate a UK Unique Taxpayer Reference. Returns the canonical form (digits
 * only) or null if it is not exactly 10 digits.
 *
 * UTRs are commonly written with a space or a trailing 'K' ("12345 67890",
 * "1234567890K" on some HMRC correspondence), so those are stripped before
 * checking. Mirrors canonicaliseNiNumber in lib/staff/secrets.ts.
 */
export function canonicaliseUtr(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s+/g, "").replace(/[Kk]$/, "");
  return UTR_REGEX.test(cleaned) ? cleaned : null;
}

/**
 * Mask a UTR for display: "1234567890" → "12*****890".
 *
 * Mirrors maskNiNumber's shape (keep a short prefix, star the middle, keep the
 * last 3) so masked identifiers look consistent across the app. Enough is shown
 * to confirm the right record is on screen; not enough to use or transcribe.
 */
export function maskUtr(utr: string | null | undefined): string {
  if (!utr) return "—";
  if (utr.length < 7) return "***";
  return `${utr.slice(0, 2)}${"*".repeat(utr.length - 5)}${utr.slice(-3)}`;
}

/**
 * HMRC verification reference: 'V' followed by 10 digits, with an optional
 * trailing letter used when a subcontractor could not be matched.
 *
 * Validated HERE rather than as a database CHECK: it is an externally-issued
 * reference typed in by hand, and pinning an external format into a constraint
 * means a migration every time HMRC does something unexpected. The database
 * enforces only a 1-40 character sanity bound; this is the tunable half.
 */
const VERIFICATION_REF_REGEX = /^V[0-9]{10}[A-Z]?$/;

export function canonicaliseVerificationReference(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[\s-]+/g, "").toUpperCase();
  return VERIFICATION_REF_REGEX.test(cleaned) ? cleaned : null;
}

const COMPANY_NUMBER_REGEX = /^([0-9]{8}|[A-Z]{2}[0-9]{6})$/;

/** Companies House number: 8 digits, or 2 letters + 6 digits (SC/NI/OC/…). */
export function canonicaliseCompanyNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[\s-]+/g, "").toUpperCase();
  return COMPANY_NUMBER_REGEX.test(cleaned) ? cleaned : null;
}

const VAT_NUMBER_REGEX = /^(GB)?([0-9]{9}|[0-9]{12})$/;

/** UK VAT registration number: 9 or 12 digits, optional GB prefix. */
export function canonicaliseVatNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[\s-]+/g, "").toUpperCase();
  return VAT_NUMBER_REGEX.test(cleaned) ? cleaned : null;
}

// ---------------------------------------------------------------------------
// PROVIDER SEAM — future HMRC CIS verification
// ---------------------------------------------------------------------------

/**
 * ⚠️  NOTHING MAY FAKE THIS SEAM — and while dark, nothing fulfils it at runtime.
 *
 * CIS M1 shipped a MANUAL verification workflow only: an org admin verifies the
 * subcontractor with HMRC out-of-band (HMRC's CIS online service or the CIS
 * helpline) and records the outcome and reference here. There is no credential,
 * no environment variable and no network call anywhere in lib/cis or the CIS
 * pages themselves.
 *
 * G5 STATUS: the real HMRC adapter now exists at
 * lib/integrations/hmrc/cis-verify.ts — DARK. It refuses (typed
 * `not_configured`, zero network) unless HMRC credentials AND
 * NEXT_PUBLIC_FEATURE_HMRC_CONNECT are set, which is never today, and its
 * outcome is recorded through the SAME recordVerification write the manual
 * path uses (source='hmrc_api'). This seam remains the contract it satisfies.
 * Rules for any implementation:
 *
 *   1. NEVER return a synthesised or guessed outcome. If HMRC cannot be reached,
 *      throw or return an error — do not fall back to `standard_20`. A fabricated
 *      verification is a tax-compliance failure, not a degraded experience.
 *   2. The `reference` must be the reference HMRC actually issued.
 *   3. An outcome may only be applied through the same guard the manual path
 *      uses (canTransition + isRateConsistent), so the provider cannot install a
 *      status/rate pair the domain would refuse.
 *   4. M2's deduction engine must refuse to compute a deduction when
 *      isVerificationStale() is true — a provider outage must block payment,
 *      never silently deduct at a stale rate.
 */
export type CisVerificationRequest = {
  legalName: string;
  tradingName: string | null;
  utr: string;
  companyNumber: string | null;
  subcontractorType: string | null;
  /** The contractor's own HMRC identifiers, supplied by the caller at M5. */
  contractorUtr: string;
  contractorAccountsOfficeReference: string;
};

export type CisVerificationOutcome = {
  /** Always one of the four recorded-outcome statuses — never a pre-outcome one. */
  status: Extract<CisStatus, "gross" | "standard_20" | "higher_30" | "failed">;
  /** The reference HMRC issued. Never invented. */
  reference: string;
  /** ISO yyyy-mm-dd — the date HMRC performed the verification. */
  verifiedAt: string;
};

export interface CisVerificationProvider {
  /** Stable identifier for audit ("manual", "hmrc-cis-api", …). */
  readonly id: string;
  verify(request: CisVerificationRequest): Promise<CisVerificationOutcome>;
}

/**
 * The only "provider" that exists in M1 — a marker for outcomes an admin typed
 * in themselves. Deliberately not a CisVerificationProvider: there is no
 * verify() to call, because a human did the verifying.
 */
export const MANUAL_VERIFICATION_SOURCE = "manual" as const;
