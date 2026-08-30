import "server-only";
import { readFailure } from "@/lib/supabase/read-failure";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptToken } from "@/lib/integrations/token-crypto";
import { hashApiKey } from "@/lib/api-auth/keygen";
import { isEnterpriseSsoEnabled } from "./flag";

/**
 * Enterprise SSO / SCIM per-org config access — the SINGLE authority for
 * whether a given org has a LIVE SSO or SCIM configuration.
 *
 * Everything here reads via the SERVICE ROLE (bypasses RLS) and scopes every
 * query EXPLICITLY to one org_id — the config tables carry secret material
 * (encrypted OIDC secret, hashed SCIM token) that the authenticated column
 * grant withholds, and the protocol endpoints have no user JWT anyway (the
 * assertion / id_token / bearer IS the credential).
 *
 * DENY-BY-DEFAULT is enforced HERE, once, so no route can drift:
 *   - the deployment build gate (FEATURE_ENTERPRISE_SSO) must be on, AND
 *   - the org's config row must exist with enabled=true.
 * A miss on either returns null and the caller denies.
 */

export type SsoProtocol = "saml" | "oidc";

export type SsoConfig = {
  id: string;
  orgId: string;
  protocol: SsoProtocol;
  enabled: boolean;
  // SAML
  samlIdpEntityId: string | null;
  samlIdpSsoUrl: string | null;
  samlIdpX509Cert: string | null;
  samlNameIdFormat: string | null;
  spEntityId: string | null;
  // OIDC
  oidcIssuer: string | null;
  oidcClientId: string | null;
  oidcClientSecretCiphertext: string | null;
  oidcDiscoveryUrl: string | null;
};

export type ScimConfig = {
  id: string;
  orgId: string;
  enabled: boolean;
  tokenPrefix: string | null;
};

type AnyRow = Record<string, unknown>;

function admin() {
  return createAdminClient();
}

function mapSso(row: AnyRow): SsoConfig {
  return {
    id: String(row.id),
    orgId: String(row.org_id),
    protocol: row.protocol as SsoProtocol,
    enabled: Boolean(row.enabled),
    samlIdpEntityId: (row.saml_idp_entity_id as string | null) ?? null,
    samlIdpSsoUrl: (row.saml_idp_sso_url as string | null) ?? null,
    samlIdpX509Cert: (row.saml_idp_x509_cert as string | null) ?? null,
    samlNameIdFormat: (row.saml_name_id_format as string | null) ?? null,
    spEntityId: (row.sp_entity_id as string | null) ?? null,
    oidcIssuer: (row.oidc_issuer as string | null) ?? null,
    oidcClientId: (row.oidc_client_id as string | null) ?? null,
    oidcClientSecretCiphertext:
      (row.oidc_client_secret_ciphertext as string | null) ?? null,
    oidcDiscoveryUrl: (row.oidc_discovery_url as string | null) ?? null,
  };
}

/**
 * Load an org's SSO config regardless of enabled state (for the admin settings
 * surface). Returns null when no row exists. Reads secret columns too — callers
 * must be admin-gated.
 */
export async function loadSsoConfig(orgId: string): Promise<SsoConfig | null> {
  const { data, error } = await (admin()
    .from("org_sso_config" as never)
    .select("*")
    .eq("org_id", orgId)
    .maybeSingle() as unknown as Promise<{ data: AnyRow | null; error: unknown }>);
  if (error || !data) return null;
  return mapSso(data);
}

/**
 * Load an org's SSO config ONLY when it is LIVE for the given protocol:
 * FEATURE_ENTERPRISE_SSO on AND row present AND enabled AND protocol matches.
 * Any miss returns null → the route denies. This is the deny-by-default gate
 * every SSO protocol route funnels through.
 */
export async function loadLiveSsoConfig(
  orgId: string,
  protocol: SsoProtocol,
): Promise<SsoConfig | null> {
  if (!isEnterpriseSsoEnabled()) return null;
  const cfg = await loadSsoConfig(orgId);
  if (!cfg || !cfg.enabled || cfg.protocol !== protocol) return null;
  return cfg;
}

/**
 * Decrypt the OIDC client secret for a live config. Throws only if the
 * ciphertext is malformed or the encryption key is absent — never returns
 * plaintext from a tampered value (authenticated GCM decrypt).
 */
export function decryptOidcClientSecret(cfg: SsoConfig): string {
  if (!cfg.oidcClientSecretCiphertext) {
    throw new Error("OIDC config has no client secret");
  }
  return decryptToken(cfg.oidcClientSecretCiphertext);
}

/**
 * Resolve a SCIM bearer token to its owning org. Hashes the presented token and
 * looks up an ENABLED org_scim_config by token_hash. Deny-by-default: returns
 * null when the flag is off, the token is blank, unknown, or the row disabled.
 *
 * TIMING SAFETY: the token is sha256-hashed before any comparison; the only
 * equality is Postgres matching the digest against the unique token_hash index
 * — identical to the api-key resolver design.
 */
export async function resolveScimConfigByToken(
  plaintextToken: string | null | undefined,
): Promise<{ orgId: string; configId: string } | null> {
  if (!isEnterpriseSsoEnabled()) return null;
  if (typeof plaintextToken !== "string" || plaintextToken.trim().length === 0) {
    return null;
  }
  const tokenHash = hashApiKey(plaintextToken.trim());
  const { data, error } = await (admin()
    .from("org_scim_config" as never)
    .select("id, org_id, enabled")
    .eq("token_hash", tokenHash)
    .maybeSingle() as unknown as Promise<{ data: AnyRow | null; error: unknown }>);
  if (error || !data) return null;
  if (!data.enabled) return null;
  return { orgId: String(data.org_id), configId: String(data.id) };
}

/**
 * Load an org's SCIM config regardless of enabled state (for the admin settings
 * surface). Returns null ONLY for "no token has ever been minted" — a read
 * FAILURE throws instead: rendering the not-yet-minted state over a broken
 * read would invite a re-mint, whose upsert overwrites token_hash and flips
 * enabled off. Exposes only the NON-SECRET columns (the token itself is
 * stored hashed and is never readable back) — callers must still be
 * admin-gated.
 */
export async function loadScimConfig(orgId: string): Promise<ScimConfig | null> {
  const { data, error } = await (admin()
    .from("org_scim_config" as never)
    .select("id, org_id, enabled, token_prefix")
    .eq("org_id", orgId)
    .maybeSingle() as unknown as Promise<{ data: AnyRow | null; error: unknown }>);
  if (error) throw readFailure("enterprise-sso: scim config", error);
  if (!data) return null;
  return {
    id: String(data.id),
    orgId: String(data.org_id),
    enabled: Boolean(data.enabled),
    tokenPrefix: (data.token_prefix as string | null) ?? null,
  };
}

/** Parse a `Bearer <token>` header into the raw token, or null on any other shape. */
export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1]! : null;
}
