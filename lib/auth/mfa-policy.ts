/**
 * Per-org MFA ENFORCEMENT decision — the pure policy at the heart of the
 * enforceable-MFA capability (org flag `organizations.require_mfa`, migration
 * 20261169000000).
 *
 * This module is intentionally pure + dependency-free so the fail-closed
 * enforcement rule can be exhaustively unit-tested. The one caller that wires
 * it to a real session is server/auth/session.ts#requireOrgContext, which
 * supplies the org flag, the caller's role, and the Supabase AAL pair.
 *
 * Existing opt-in TOTP enrol/challenge is UNCHANGED — this only adds the
 * ENFORCEMENT layer, and only when an org has explicitly turned it on.
 */

/** Roles for which MFA can be enforced. Owner + admin are the privileged,
 * data-and-billing-mutating roles; everyone else is out of scope by design so
 * turning enforcement on never bounces field staff. */
export const MFA_PRIVILEGED_ROLES = ["owner", "admin"] as const;

export function isPrivilegedRole(role: string | null | undefined): boolean {
  return (
    typeof role === "string" &&
    (MFA_PRIVILEGED_ROLES as readonly string[]).includes(role)
  );
}

/** Supabase's assurance-level pair (from `mfa.getAuthenticatorAssuranceLevel`). */
export type AalPair = {
  currentLevel: string | null;
  nextLevel: string | null;
};

/**
 * The gate outcome:
 *   - "allow"     → let the request through (no enforcement, or already aal2).
 *   - "challenge" → the user HAS a verified factor but the session is aal1;
 *                   send them to complete the TOTP challenge (→ aal2).
 *   - "enroll"    → enforcement applies but the user has NO usable factor (or
 *                   the AAL state is unknown); they must enrol before entering.
 */
export type MfaGateDecision = "allow" | "challenge" | "enroll";

/**
 * Decide whether a privileged user in an MFA-required org may proceed.
 *
 * FAIL-CLOSED: when enforcement applies to a privileged role and we cannot
 * positively confirm an aal2 session, we NEVER return "allow". A missing/unknown
 * AAL pair resolves to "enroll" (the most restrictive non-loop outcome), so a
 * transient failure to read the assurance level cannot become an open door.
 *
 * Default-off is honoured first: require_mfa=false → always "allow", so nothing
 * changes for orgs that have not opted in, nor for non-privileged members.
 */
export function mfaGateDecision(input: {
  requireMfa: boolean;
  role: string | null | undefined;
  aal: AalPair | null | undefined;
}): MfaGateDecision {
  if (!input.requireMfa) return "allow";
  if (!isPrivilegedRole(input.role)) return "allow";

  const current = input.aal?.currentLevel ?? null;
  const next = input.aal?.nextLevel ?? null;

  // Already stepped up — the only "allow" path under enforcement.
  if (current === "aal2") return "allow";
  // Verified factor present but not yet satisfied this session → challenge.
  if (next === "aal2") return "challenge";
  // No factor, or unknown state → must enrol. Fail-closed default.
  return "enroll";
}
