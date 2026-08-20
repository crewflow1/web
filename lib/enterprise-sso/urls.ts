import "server-only";

/**
 * Canonical SSO endpoint URL derivation. Kept in one place so the SP metadata,
 * the ACS validator (Recipient check), and the OIDC redirect_uri all agree on
 * exactly the same strings — a mismatch would fail Recipient/redirect_uri
 * validation, so this is a single source of truth.
 */

export function spEntityId(origin: string, orgId: string): string {
  return `${origin}/api/sso/saml/${orgId}/metadata`;
}

export function acsUrl(origin: string, orgId: string): string {
  return `${origin}/api/sso/saml/${orgId}/acs`;
}

export function oidcRedirectUri(origin: string, orgId: string): string {
  return `${origin}/api/sso/oidc/${orgId}/callback`;
}
