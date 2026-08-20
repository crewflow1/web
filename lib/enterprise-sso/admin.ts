import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptToken, isTokenEncryptionConfigured } from "@/lib/integrations/token-crypto";
import { generateApiKey } from "@/lib/api-auth/keygen";

/**
 * Enterprise SSO / SCIM CONFIG WRITERS (service-role, org-scoped).
 *
 * These are the activation-side writers. They MUST only be called from an
 * admin-gated context (see app/(app)/settings/sso/actions.ts, which enforces
 * requireOrgContext + owner/admin role + the feature flag before calling).
 * Every write is pinned to an explicit orgId; there is no tenant-writable RLS
 * policy, so these service-role writes are the ONLY write path.
 *
 * SECRETS: the OIDC client secret is ENCRYPTED here before it touches the DB;
 * the SCIM bearer token is HASHED and the plaintext returned exactly once.
 */

type AnyRow = Record<string, unknown>;

export type SamlConfigInput = {
  idpEntityId: string;
  idpSsoUrl: string;
  idpX509Cert: string;
  nameIdFormat?: string | null;
  spEntityId?: string | null;
};

export type OidcConfigInput = {
  issuer: string;
  clientId: string;
  clientSecret: string; // PLAINTEXT — encrypted before storage
  discoveryUrl?: string | null;
};

/** Upsert the org's SAML config. Starts DISABLED — a separate enable step flips
 *  the per-org dark switch once the admin has verified the metadata. */
export async function upsertSamlConfig(
  orgId: string,
  createdBy: string | null,
  input: SamlConfigInput,
): Promise<{ ok: boolean; error?: string }> {
  const admin = createAdminClient();
  const { error } = await (admin.from("org_sso_config" as never).upsert(
    {
      org_id: orgId,
      protocol: "saml",
      enabled: false,
      saml_idp_entity_id: input.idpEntityId,
      saml_idp_sso_url: input.idpSsoUrl,
      saml_idp_x509_cert: input.idpX509Cert,
      saml_name_id_format: input.nameIdFormat ?? null,
      sp_entity_id: input.spEntityId ?? null,
      oidc_issuer: null,
      oidc_client_id: null,
      oidc_client_secret_ciphertext: null,
      oidc_discovery_url: null,
      created_by: createdBy,
    } as never,
    { onConflict: "org_id" } as never,
  ) as unknown as Promise<{ error: { message?: string } | null }>);
  if (error) return { ok: false, error: error.message ?? "write_failed" };
  return { ok: true };
}

/** Upsert the org's OIDC config. The client secret is ENCRYPTED before storage;
 *  refuses if the encryption key is absent (never stores a plaintext secret). */
export async function upsertOidcConfig(
  orgId: string,
  createdBy: string | null,
  input: OidcConfigInput,
): Promise<{ ok: boolean; error?: string }> {
  if (!isTokenEncryptionConfigured()) {
    return { ok: false, error: "encryption_key_missing" };
  }
  const ciphertext = encryptToken(input.clientSecret);
  const admin = createAdminClient();
  const { error } = await (admin.from("org_sso_config" as never).upsert(
    {
      org_id: orgId,
      protocol: "oidc",
      enabled: false,
      saml_idp_entity_id: null,
      saml_idp_sso_url: null,
      saml_idp_x509_cert: null,
      saml_name_id_format: null,
      sp_entity_id: null,
      oidc_issuer: input.issuer,
      oidc_client_id: input.clientId,
      oidc_client_secret_ciphertext: ciphertext,
      oidc_discovery_url: input.discoveryUrl ?? null,
      created_by: createdBy,
    } as never,
    { onConflict: "org_id" } as never,
  ) as unknown as Promise<{ error: { message?: string } | null }>);
  if (error) return { ok: false, error: error.message ?? "write_failed" };
  return { ok: true };
}

/** Flip the per-org SSO dark switch. Enabling requires a config row to exist. */
export async function setSsoEnabled(
  orgId: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const admin = createAdminClient();
  const { data, error } = await (admin
    .from("org_sso_config" as never)
    .update({ enabled } as never)
    .eq("org_id", orgId)
    .select("id") as unknown as Promise<{ data: AnyRow[] | null; error: { message?: string } | null }>);
  if (error) return { ok: false, error: error.message ?? "write_failed" };
  if (!data || data.length === 0) return { ok: false, error: "no_config" };
  return { ok: true };
}

/** Mint a NEW SCIM bearer token for the org (rotates any existing one). Returns
 *  the plaintext ONCE — it is only stored hashed. Starts DISABLED. */
export async function mintScimToken(
  orgId: string,
  createdBy: string | null,
): Promise<{ ok: boolean; token?: string; error?: string }> {
  const generated = generateApiKey();
  const admin = createAdminClient();
  const { error } = await (admin.from("org_scim_config" as never).upsert(
    {
      org_id: orgId,
      enabled: false,
      token_hash: generated.keyHash,
      token_prefix: generated.keyPrefix,
      token_minted_at: new Date().toISOString(),
      created_by: createdBy,
    } as never,
    { onConflict: "org_id" } as never,
  ) as unknown as Promise<{ error: { message?: string } | null }>);
  if (error) return { ok: false, error: error.message ?? "write_failed" };
  return { ok: true, token: generated.plaintext };
}

/** Flip the per-org SCIM dark switch. Enabling requires a token to exist (the
 *  DB CHECK constraint org_scim_config_enabled_needs_token also enforces this). */
export async function setScimEnabled(
  orgId: string,
  enabled: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const admin = createAdminClient();
  const { data, error } = await (admin
    .from("org_scim_config" as never)
    .update({ enabled } as never)
    .eq("org_id", orgId)
    .select("id") as unknown as Promise<{ data: AnyRow[] | null; error: { message?: string } | null }>);
  if (error) return { ok: false, error: error.message ?? "write_failed" };
  if (!data || data.length === 0) return { ok: false, error: "no_config" };
  return { ok: true };
}
