import "server-only";
import { createHash, randomBytes } from "node:crypto";

import type { AccountingProvider } from "./adapters";

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
};

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
