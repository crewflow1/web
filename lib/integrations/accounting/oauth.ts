import "server-only";
import { createHash, randomBytes } from "node:crypto";

import { decryptToken } from "@/lib/integrations/token-crypto";
import { refreshOAuthToken } from "@/lib/integrations/oauth-refresh";

// Import the provider type from the adapter TYPES module (not ./adapters), so
// this server-only module does not pull the adapter index at runtime — the
// adapters value-import `isProviderConnectable` from here, so a value import the
// other way would be a cycle. (The banking / telematics substrates do the same.)
import type { AccountingProvider } from "./adapters/types";

/**
 * Accounting OAuth — the provider-agnostic CONNECT substrate. DARK.
 *
 * This module is the OAuth half of "connect your Xero / QuickBooks account". It
 * resolves a provider's OAuth client credentials from the environment, builds
 * the authorize-URL (PKCE) a tenant is redirected to, and exchanges the returned
 * code for tokens. Every one of those steps is credential-gated.
 *
 * ── THE DARK-BY-DEFAULT INVARIANT ───────────────────────────────────────────
 * `isXeroConnectable()` / `isQuickbooksConnectable()` are pure env reads: true
 * only when BOTH the client id and client secret are present and non-empty —
 * which is NEVER, today. When a provider is not connectable:
 *   - buildAuthorizeUrl REFUSES (returns { ok:false, reason:'not_configured' })
 *     WITHOUT constructing a URL and WITHOUT issuing PKCE material, and
 *   - exchangeCodeForTokens REFUSES the same way WITHOUT any `fetch`.
 * There is no code path from "no credentials" to a provider network call or a
 * stored token. The token-exchange `fetch` lives strictly AFTER the connectable
 * guard, so it is structurally unreachable dark. The security suite proves this
 * against this source.
 *
 * ── ACTIVATION ──────────────────────────────────────────────────────────────
 * Set the provider's client credentials (below), then flip
 * FEATURE_ACCOUNTING_CONNECT. No code change is required to reach the live path:
 *   Xero        → XERO_CLIENT_ID, XERO_CLIENT_SECRET
 *   QuickBooks  → QBO_CLIENT_ID,  QBO_CLIENT_SECRET
 *   Sage        → SAGE_CLIENT_ID, SAGE_CLIENT_SECRET
 * The redirect URI is derived per-request from the request origin, so no extra
 * env is needed for it. Secrets are read here and NEVER logged.
 */

/** The env var names whose presence makes a provider connectable. Client id + secret. */
const PROVIDER_ENV: Record<
  AccountingProvider,
  { clientId: string; clientSecret: string }
> = {
  xero: { clientId: "XERO_CLIENT_ID", clientSecret: "XERO_CLIENT_SECRET" },
  quickbooks: { clientId: "QBO_CLIENT_ID", clientSecret: "QBO_CLIENT_SECRET" },
  sage: { clientId: "SAGE_CLIENT_ID", clientSecret: "SAGE_CLIENT_SECRET" },
};

/**
 * The master feature flag. Even WITH credentials the connect surface stays dark
 * until this is truthy — a second, deliberate switch so credentials alone (e.g.
 * a stray env leak) cannot silently open a live OAuth flow.
 */
export function accountingConnectFeatureEnabled(): boolean {
  const v = process.env.FEATURE_ACCOUNTING_CONNECT;
  return v === "1" || v === "true";
}

function envValue(name: string): string | null {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** A pure env read — no network, never throws. Credentials present AND flag on. */
export function isProviderConnectable(provider: AccountingProvider): boolean {
  if (!accountingConnectFeatureEnabled()) return false;
  const keys = PROVIDER_ENV[provider];
  return envValue(keys.clientId) !== null && envValue(keys.clientSecret) !== null;
}

export function isXeroConnectable(): boolean {
  return isProviderConnectable("xero");
}

export function isQuickbooksConnectable(): boolean {
  return isProviderConnectable("quickbooks");
}

export function isSageConnectable(): boolean {
  return isProviderConnectable("sage");
}

/** Resolve a provider's OAuth client credentials, or null when absent (dark). */
function resolveClient(
  provider: AccountingProvider,
): { clientId: string; clientSecret: string } | null {
  const keys = PROVIDER_ENV[provider];
  const clientId = envValue(keys.clientId);
  const clientSecret = envValue(keys.clientSecret);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Provider OAuth endpoints. Only ever contacted AFTER the connectable guard. */
const PROVIDER_OAUTH: Record<
  AccountingProvider,
  { authorizeUrl: string; tokenUrl: string; scope: string }
> = {
  xero: {
    authorizeUrl: "https://login.xero.com/identity/connect/authorize",
    tokenUrl: "https://identity.xero.com/connect/token",
    scope: "openid profile email accounting.transactions offline_access",
  },
  quickbooks: {
    authorizeUrl: "https://appcenter.intuit.com/connect/oauth2",
    tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    scope: "com.intuit.quickbooks.accounting",
  },
  // Sage Business Cloud Accounting OAuth 2.0 (PKCE, S256). The authorize
  // endpoint is the Sage identity "central" login; the token endpoint is the
  // Sage Accounting OAuth host. `full_access` is the read+write scope the push
  // and pull paths both need.
  sage: {
    authorizeUrl: "https://www.sageone.com/oauth2/auth/central",
    tokenUrl: "https://oauth.accounting.sage.com/token",
    scope: "full_access",
  },
};

/**
 * Resolve the OAuth redirect URI for a provider callback.
 *
 * SECURITY (ACTIVATION GATE). The redirect_uri MUST be pinned to a trusted,
 * allow-listed host at activation, or a spoofed Host / X-Forwarded-* header
 * could point the authorization code at an attacker-controlled origin. The
 * accounting_connections migration (20261095) documents this as a BLOCKING
 * activation prerequisite.
 *
 * `ACCOUNTING_REDIRECT_URI`, when set, is that allow-listed ORIGIN (e.g.
 * `https://app.example`) and OVERRIDES the request-origin-derived value — the
 * authorize redirect and the token-exchange redirect then both use it, exactly
 * as OAuth requires them to match. It is declared here but intentionally UNSET:
 * unset, behaviour is unchanged (origin taken from the request), which is fine
 * dark and in a trusted single-origin deploy. Activation sets it to close the
 * host-spoofing gate. The callback PATH is fixed and appended here so the
 * connect and callback routes can never construct divergent URIs.
 */
export function accountingRedirectUri(
  provider: AccountingProvider,
  requestOrigin: string,
): string {
  const pinned = envValue("ACCOUNTING_REDIRECT_URI");
  const base = (pinned ?? requestOrigin).replace(/\/+$/, "");
  return `${base}/api/integrations/accounting/${provider}/callback`;
}

/** The PKCE + state material a connect redirect must persist to verify the callback. */
export type AuthorizeChallenge = {
  /** Where to send the tenant's browser to authorize. */
  url: string;
  /** Opaque anti-CSRF state — echoed back on the callback and compared. */
  state: string;
  /** PKCE verifier — kept server-side (httpOnly cookie), never sent on authorize. */
  codeVerifier: string;
};

export type AuthorizeResult =
  | { ok: true; challenge: AuthorizeChallenge }
  | { ok: false; reason: "not_configured"; message: string };

/** base64url of a buffer — no padding, URL-safe. */
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Build the authorize URL + PKCE challenge for a provider. REFUSES (no URL, no
 * PKCE material) when the provider is not connectable — the dark path. The
 * caller persists `state` + `codeVerifier` (httpOnly cookies) and redirects to
 * `url`.
 */
export function buildAuthorizeUrl(
  provider: AccountingProvider,
  redirectUri: string,
): AuthorizeResult {
  // DARK GUARD FIRST. Without client credentials (or with the flag off) we
  // return without minting any PKCE material or constructing a URL.
  const client = isProviderConnectable(provider) ? resolveClient(provider) : null;
  if (!client) {
    return {
      ok: false,
      reason: "not_configured",
      message:
        `${provider} is not configured. Set its OAuth client credentials and ` +
        `enable FEATURE_ACCOUNTING_CONNECT to enable the connection flow.`,
    };
  }

  const cfg = PROVIDER_OAUTH[provider];
  const state = base64url(randomBytes(32));
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(
    createHash("sha256").update(codeVerifier).digest(),
  );

  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", cfg.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  return { ok: true, challenge: { url: url.toString(), state, codeVerifier } };
}

/** Tokens returned by a successful exchange (unreachable dark). */
export type ProviderTokens = {
  accessToken: string;
  refreshToken: string | null;
  /** Absolute expiry, ISO 8601. */
  expiresAt: string | null;
  /** Provider account handle: Xero tenant id or QBO realm id, when present. */
  externalTenantId: string | null;
  realmId: string | null;
};

export type ExchangeResult =
  | { ok: true; tokens: ProviderTokens }
  | { ok: false; reason: "not_configured" | "error"; message: string };

/**
 * Exchange an authorization code for tokens. REFUSES (no `fetch`) when the
 * provider is not connectable — the dark path is structural: the network call
 * below is unreachable without client credentials. `realmId` for QuickBooks is
 * carried on the callback query, so the caller passes it in.
 */
export async function exchangeCodeForTokens(params: {
  provider: AccountingProvider;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  realmId?: string | null;
}): Promise<ExchangeResult> {
  const { provider, code, codeVerifier, redirectUri, realmId } = params;

  // DARK GUARD FIRST. No credentials → return WITHOUT touching the network.
  // Everything below (the only `fetch` in this module) is unreachable dark.
  const client = isProviderConnectable(provider) ? resolveClient(provider) : null;
  if (!client) {
    return {
      ok: false,
      reason: "not_configured",
      message: `${provider} is not configured; no token exchange is possible.`,
    };
  }

  const cfg = PROVIDER_OAUTH[provider];
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    client_id: client.clientId,
  });
  // Both Xero and QBO accept HTTP Basic client auth. The secret goes in the
  // Authorization header, never in a log line or the URL.
  const basic = Buffer.from(`${client.clientId}:${client.clientSecret}`).toString(
    "base64",
  );

  let res: Response;
  try {
    res = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        authorization: `Basic ${basic}`,
      },
      body: body.toString(),
    });
  } catch (e) {
    return {
      ok: false,
      reason: "error",
      message: `token exchange request failed: ${e instanceof Error ? e.message : "network error"}`,
    };
  }

  if (!res.ok) {
    // Do NOT echo the response body wholesale — it can carry sensitive detail.
    return { ok: false, reason: "error", message: `token exchange returned ${res.status}` };
  }

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    return { ok: false, reason: "error", message: "token exchange returned no access token" };
  }

  const expiresAt =
    typeof json.expires_in === "number"
      ? new Date(Date.now() + json.expires_in * 1000).toISOString()
      : null;

  return {
    ok: true,
    tokens: {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt,
      // Xero resolves the tenant id via a follow-up /connections call; QBO
      // carries the realm id on the callback query. Both are wired at activation.
      externalTenantId: null,
      realmId: realmId ?? null,
    },
  };
}

/**
 * Decrypt-on-use seam. Tokens are stored as AES-256-GCM ciphertext (the callback
 * encrypts them before the DB write); this is the SINGLE place the live push /
 * refresh path turns them back into usable secrets, immediately before a provider
 * API call. `decryptToken` throws on a wrong key or any tamper, so a corrupted
 * token can never be silently used. Pure — no network, no darkness concern (a
 * caller only reaches here after resolving a connected, connectable provider).
 * Nobody calls this while dark; it is wired at activation.
 */
export function decryptStoredTokens(stored: {
  accessToken: string;
  refreshToken: string | null;
}): { accessToken: string; refreshToken: string | null } {
  return {
    accessToken: decryptToken(stored.accessToken),
    refreshToken:
      stored.refreshToken !== null ? decryptToken(stored.refreshToken) : null,
  };
}

/**
 * Refresh an access token for a connected provider. REFUSES (no network) when
 * the provider is not connectable — the dark guard is FIRST, so the refresh
 * `fetch` (inside the shared helper) is unreachable without client credentials +
 * the feature flag, exactly like the code exchange. The refresh token is a
 * PLAINTEXT secret the caller has already decrypted; it is never logged.
 *
 * On success the returned `refreshToken` is the provider's ROTATED token when it
 * issued one, else null — the caller keeps the existing stored refresh token in
 * that case rather than nulling it.
 */
export async function refreshAccessToken(params: {
  provider: AccountingProvider;
  refreshToken: string;
}): Promise<ExchangeResult> {
  const { provider, refreshToken } = params;

  // DARK GUARD FIRST. No credentials → return WITHOUT touching the network. The
  // helper's `fetch` is unreachable dark because this guard precedes it.
  const client = isProviderConnectable(provider) ? resolveClient(provider) : null;
  if (!client) {
    return {
      ok: false,
      reason: "not_configured",
      message: `${provider} is not configured; no token refresh is possible.`,
    };
  }

  const cfg = PROVIDER_OAUTH[provider];
  const refreshed = await refreshOAuthToken({
    tokenUrl: cfg.tokenUrl,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    refreshToken,
  });
  if (!refreshed.ok) {
    return { ok: false, reason: "error", message: refreshed.message };
  }

  return {
    ok: true,
    tokens: {
      accessToken: refreshed.tokens.accessToken,
      refreshToken: refreshed.tokens.refreshToken,
      expiresAt: refreshed.tokens.expiresAt,
      // A refresh never re-resolves the account handle; the caller preserves the
      // externalTenantId / realmId it already stored.
      externalTenantId: null,
      realmId: null,
    },
  };
}

/** Xero's connections endpoint — resolves which tenant an access token can act on. */
const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";

export type TenantResolution =
  | { ok: true; tenantId: string }
  | { ok: false; reason: "not_configured" | "error"; message: string };

/**
 * Resolve the Xero tenant id for a freshly-exchanged access token by calling
 * `GET /connections`. Xero's authorization_code exchange returns tokens but NOT
 * the tenant to act on; a connected org may have authorised one or more tenants,
 * and every Accounting API call needs the `Xero-tenant-id` header. This is the
 * follow-up that turns "we have a token" into "we know which company book to
 * post to", closing the connect flow's `no_account` dead-end.
 *
 * REFUSES (no network) when Xero is not connectable — the dark guard is first,
 * so the `fetch` is unreachable dark. Returns the FIRST tenant of type
 * `ORGANISATION`; a token with no organisation connection is an `error`.
 */
export async function resolveXeroTenantId(
  accessToken: string,
): Promise<TenantResolution> {
  // DARK GUARD FIRST. Not connectable → no network call.
  if (!isProviderConnectable("xero")) {
    return {
      ok: false,
      reason: "not_configured",
      message: "xero is not configured; cannot resolve a tenant id.",
    };
  }

  let res: Response;
  try {
    res = await fetch(XERO_CONNECTIONS_URL, {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    });
  } catch (e) {
    return {
      ok: false,
      reason: "error",
      message: `xero connections request failed: ${e instanceof Error ? e.message : "network error"}`,
    };
  }
  if (!res.ok) {
    return { ok: false, reason: "error", message: `xero connections returned ${res.status}` };
  }

  const json = (await res.json()) as Array<{
    tenantId?: string;
    tenantType?: string;
  }>;
  const list = Array.isArray(json) ? json : [];
  const org = list.find((c) => c.tenantType === "ORGANISATION" && c.tenantId);
  const tenantId = (org ?? list.find((c) => c.tenantId))?.tenantId ?? null;
  if (!tenantId) {
    return { ok: false, reason: "error", message: "xero connections returned no tenant" };
  }
  return { ok: true, tenantId };
}

/** Sage's businesses endpoint — resolves which business an access token can act on. */
const SAGE_BUSINESSES_URL = "https://api.accounting.sage.com/v3.1/businesses";

/**
 * Resolve the Sage business id for a freshly-exchanged access token by calling
 * `GET /v3.1/businesses`. Like Xero, Sage's authorization_code exchange returns
 * tokens but NOT the business to act on; a connected user may have access to one
 * or more businesses, and every Accounting API call scopes to one via the
 * `X-Business` header. This is the follow-up that turns "we have a token" into
 * "we know which business book to post to", so the connection completes with a
 * real account handle (stored in external_tenant_id, exactly like Xero's tenant).
 *
 * REFUSES (no network) when Sage is not connectable — the dark guard is first,
 * so the `fetch` is unreachable dark. Returns the FIRST business id; a token with
 * no business is an `error` (the connection would otherwise have no handle).
 */
export async function resolveSageBusinessId(
  accessToken: string,
): Promise<TenantResolution> {
  // DARK GUARD FIRST. Not connectable → no network call.
  if (!isProviderConnectable("sage")) {
    return {
      ok: false,
      reason: "not_configured",
      message: "sage is not configured; cannot resolve a business id.",
    };
  }

  let res: Response;
  try {
    res = await fetch(SAGE_BUSINESSES_URL, {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    });
  } catch (e) {
    return {
      ok: false,
      reason: "error",
      message: `sage businesses request failed: ${e instanceof Error ? e.message : "network error"}`,
    };
  }
  if (!res.ok) {
    return { ok: false, reason: "error", message: `sage businesses returned ${res.status}` };
  }

  const json = (await res.json()) as { $items?: Array<{ id?: string }> } | null;
  const list = Array.isArray(json?.$items) ? json!.$items : [];
  const businessId = list.find((b) => typeof b.id === "string" && b.id)?.id ?? null;
  if (!businessId) {
    return { ok: false, reason: "error", message: "sage businesses returned no business" };
  }
  return { ok: true, tenantId: businessId };
}
