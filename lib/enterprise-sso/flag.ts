import "server-only";
import { env } from "@/lib/env";

/**
 * Enterprise SSO + SCIM deployment build gate.
 *
 * DARK BY DEFAULT. This is the FIRST of two independent switches — the
 * deployment-wide build gate. The SECOND is the per-org `enabled` bool on the
 * config row (see lib/enterprise-sso/config.ts). BOTH must be on before any
 * SSO/SCIM path does anything:
 *
 *   - While this returns false the SSO routes (SAML ACS + SP metadata, OIDC
 *     start + callback) behave as if they do not exist (404) and the SCIM
 *     endpoints return 401 — the surface does not exist yet.
 *   - Even when this is true, an org whose config row is missing or has
 *     enabled=false is denied. Deny-by-default at both layers.
 *
 * NOTHING auto-provisions regardless of this flag: a validated assertion / SCIM
 * record is only ever mapped to an EXISTING membership by verified email; an
 * unmatched subject is denied. There is no auto-create-user path anywhere.
 *
 * Server-only: the flag never rides into a client bundle.
 */
export function isEnterpriseSsoEnabled(): boolean {
  return env.FEATURE_ENTERPRISE_SSO === "true";
}
