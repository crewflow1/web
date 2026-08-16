/**
 * Per-org MFA ENFORCEMENT decision — the pure policy at the heart of the
 * enforceable-MFA capability (org flag `organizations.require_mfa`, migration
 * 20261170000000).
 *
 * The decision core (`mfaGateDecision`) is intentionally pure + dependency-free
 * so the fail-closed enforcement rule can be exhaustively unit-tested. The one
 * caller that wires it to a real session is
 * server/auth/session.ts#requireOrgContext, which supplies the org flag, the
 * caller's role, and the Supabase AAL pair.
 *
 * Enforcement is doubly gated and BUILT-BUT-OFF: it cannot engage unless BOTH
 * the deployment build gate (`mfaEnforcementBuildEnabled`, env
 * FEATURE_MFA_ENFORCEMENT, default off) AND a given org's opt-in flag
 * (require_mfa, default off) are on. Existing opt-in TOTP enrol/challenge is
 * UNCHANGED — this only adds the ENFORCEMENT layer.
 */

import { env } from "@/lib/env";

/**
 * BUILD/FEATURE gate for MFA ENFORCEMENT (env FEATURE_MFA_ENFORCEMENT), default
 * OFF. This is the first, deployment-wide switch: while it is off the default
 * session path is completely inert (no AAL read, no aal2 requirement), so no
 * org can be gated regardless of its require_mfa flag. It is deliberately
 * separate from the pure decision above so the aal2 logic stays exhaustively
 * unit-testable without env, while the live wiring in requireOrgContext must
 * clear BOTH this gate and the per-org opt-in before enforcement can engage.
 */
export function mfaEnforcementBuildEnabled(): boolean {
  return env.FEATURE_MFA_ENFORCEMENT === "true";
}

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
