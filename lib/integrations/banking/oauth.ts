import "server-only";
import { createHash, randomBytes } from "node:crypto";

import { decryptToken } from "@/lib/integrations/token-crypto";

import type { BankingProvider } from "./adapters";

/**
 * Banking OAuth — the Open-Banking aggregator CONNECT substrate. DARK.
 *
 * This module is the OAuth half of "connect your bank" via an Account
 * Information aggregator (TrueLayer / Plaid / Nordigen-GoCardless). It resolves
 * the aggregator's OAuth client credentials from the environment, builds the
 * authorize URL (PKCE) a tenant is redirected to, and exchanges the returned
 * code for tokens. Every one of those steps is credential-gated and, above that,
 * legally gated (see the FCA boundary below).
 *
 * ── FCA LEGAL BOUNDARY (BLOCKING) ───────────────────────────────────────────
 * Open Banking / Account Information Services are REGULATED in the UK. Pulling a
 * customer's bank data requires FCA authorisation (or agent permission) as an
 * Account Information Service Provider (AISP), in addition to an aggregator
 * contract. This substrate exists to hold the SEAM only — it must NEVER connect
 * to a live bank before that authorisation is in place. The dark-by-default
 * invariant below is the technical guarantee that it cannot.
 *
 * ── THE DARK-BY-DEFAULT INVARIANT ───────────────────────────────────────────
 * `isBankingProviderConnectable(p)` is a pure env read: true only when ALL of
 *   - NEXT_PUBLIC_FEATURE_BANKING_CONNECT is on (switch 1),
 *   - BANKING_CLIENT_ID and BANKING_CLIENT_SECRET are present (switch 2), AND
 *   - the requested provider equals the bound BANKING_PROVIDER,
 * hold — which is NEVER, today. When a provider is not connectable:
 *   - buildAuthorizeUrl REFUSES (returns { ok:false, reason:'not_configured' })
 *     WITHOUT constructing a URL and WITHOUT issuing PKCE material, and
 *   - exchangeCodeForTokens REFUSES the same way WITHOUT any `fetch`.
 * There is no code path from "no credentials" to an aggregator network call or a
 * stored token. The token-exchange `fetch` lives strictly AFTER the connectable
 * guard, so it is structurally unreachable dark. The security suite proves this
 * against this source.
 *
 * ── ACTIVATION (config + LEGAL, not engineering) ────────────────────────────
 * After FCA AISP authorisation is obtained and an aggregator contract signed:
 *   BANKING_PROVIDER            → 'truelayer' | 'plaid' | 'nordigen' (bind one)
 *   BANKING_CLIENT_ID           → the aggregator OAuth client id
 *   BANKING_CLIENT_SECRET       → the aggregator OAuth client secret
 *   NEXT_PUBLIC_FEATURE_BANKING_CONNECT="true"
 *   INTEGRATION_TOKEN_ENCRYPTION_KEY (shared) — so tokens are encrypted at rest.
 * No code change reaches the live path. The redirect URI is derived per-request
 * from the request origin; it MUST be origin-pinned to a trusted allow-listed
 * host at activation. Secrets are read here and NEVER logged.
 */

/** The aggregators this substrate can bind an org to. A small, closed set. */
export type { BankingProvider } from "./adapters";
export const BANKING_PROVIDERS: readonly BankingProvider[] = [
  "truelayer",
  "plaid",
  "nordigen",
];

/**
 * The master feature flag (switch 1). Even WITH credentials the connect surface
 * stays dark until this is truthy — a second, deliberate switch so credentials
 * alone (e.g. a stray env leak) cannot silently open a live OAuth flow.
 */
export function bankingConnectFeatureEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FEATURE_BANKING_CONNECT === "true";
}

function envValue(name: string): string | null {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Which single aggregator this deployment is bound to, or null when unbound.
 * Unlike the accounting substrate (per-provider credentials), banking uses ONE
 * OAuth client + an explicit BANKING_PROVIDER binding: an unbound deployment
 * connects to nothing. A pure env read; never throws.
 */
export function resolveActiveBankingProvider(): BankingProvider | null {
  const v = envValue("BANKING_PROVIDER");
  if (v === null) return null;
  return (BANKING_PROVIDERS as readonly string[]).includes(v)
    ? (v as BankingProvider)
    : null;
}

/**
 * A pure env read — no network, never throws. A provider is connectable only when
 * the feature flag is on, the OAuth client credentials are present, AND that
 * provider is the bound BANKING_PROVIDER. False for every provider today.
 */
export function isBankingProviderConnectable(provider: BankingProvider): boolean {
  if (!bankingConnectFeatureEnabled()) return false;
  if (resolveActiveBankingProvider() !== provider) return false;
  return (
    envValue("BANKING_CLIENT_ID") !== null &&
    envValue("BANKING_CLIENT_SECRET") !== null
  );
}

/** Resolve the OAuth client credentials, or null when absent (dark). */
function resolveClient(): { clientId: string; clientSecret: string } | null {
  const clientId = envValue("BANKING_CLIENT_ID");
  const clientSecret = envValue("BANKING_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Public credential resolver for adapters whose DATA API authenticates with the
 * client id + secret in every request (Plaid: `client_id`/`secret` in the JSON
 * body — NOT a Bearer token like TrueLayer/Nordigen). Returns null when either is
 * absent, which is ALWAYS today — so an adapter that calls this stays dark unless
 * the connectable guard has already passed. A single source for the credentials
 * so no adapter re-reads env directly. Never logs the secret.
 */
export function resolveBankingClientCredentials(): {
  clientId: string;
  clientSecret: string;
} | null {
  return resolveClient();
}

/**
 * Aggregator OAuth endpoints. Only ever contacted AFTER the connectable guard.
 * These are the documented aggregator endpoints; they are wired at activation and
 * are unreachable while dark.
 */
const PROVIDER_OAUTH: Record<
  BankingProvider,
  { authorizeUrl: string; tokenUrl: string; scope: string }
> = {
  truelayer: {
    authorizeUrl: "https://auth.truelayer.com/",
    tokenUrl: "https://auth.truelayer.com/connect/token",
    scope: "info accounts balance transactions offline_access",
  },
  plaid: {
    // Plaid's Link/OAuth handshake differs in detail; these are the seam
    // endpoints wired at activation behind the connectable guard.
    authorizeUrl: "https://cdn.plaid.com/link/v2/stable/link.html",
    tokenUrl: "https://production.plaid.com/item/public_token/exchange",
    scope: "transactions",
  },
  nordigen: {
    // Nordigen / GoCardless Bank Account Data — token + requisition flow.
    authorizeUrl: "https://bankaccountdata.gocardless.com/api/v2/requisitions/",
    tokenUrl: "https://bankaccountdata.gocardless.com/api/v2/token/new/",
    scope: "transactions",
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
  provider: BankingProvider,
  redirectUri: string,
): AuthorizeResult {
  // DARK GUARD FIRST. Without client credentials (flag off / provider unbound)
  // we return without minting any PKCE material or constructing a URL.
  const client = isBankingProviderConnectable(provider) ? resolveClient() : null;
  if (!client) {
    return {
      ok: false,
      reason: "not_configured",
      message:
        `${provider} bank feed is not configured. Obtain FCA AISP authorisation, ` +
        `set the aggregator OAuth client credentials, bind BANKING_PROVIDER and ` +
        `enable NEXT_PUBLIC_FEATURE_BANKING_CONNECT to enable the connection flow.`,
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

/** Tokens + non-secret connection handle returned by a successful exchange (unreachable dark). */
export type ProviderTokens = {
  accessToken: string;
  refreshToken: string | null;
  /** Absolute expiry, ISO 8601. */
  expiresAt: string | null;
  /** The aggregator connection reference: TrueLayer connection id / Plaid item_id / Nordigen requisition id. */
  connectionRef: string | null;
  /** The bank the tenant chose, when the aggregator resolves it on the callback. */
  institutionId: string | null;
  institutionName: string | null;
};

export type ExchangeResult =
  | { ok: true; tokens: ProviderTokens }
  | {
      ok: false;
      reason: "not_configured" | "error";
      message: string;
      /**
       * TERMINAL failure — the grant itself is dead (invalid_grant / 400 / 401 /
       * 403 from the token endpoint), so a retry can never succeed without a fresh
       * OAuth consent. Absent/false means the failure is TRANSIENT (network blip /
       * 5xx / malformed body) and the caller may retry on a later tick WITHOUT
       * treating the connection as permanently dead. Only `refreshAccessToken`
       * sets this; the initial code exchange never does.
       */
      terminal?: boolean;
    };

/**
 * Exchange an authorization code for tokens. REFUSES (no `fetch`) when the
 * provider is not connectable — the dark path is structural: the network call
 * below is unreachable without client credentials. The aggregator connection
 * reference is carried on the callback query, so the caller passes it in.
 */
export async function exchangeCodeForTokens(params: {
  provider: BankingProvider;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  connectionRef?: string | null;
}): Promise<ExchangeResult> {
  const { provider, code, codeVerifier, redirectUri, connectionRef } = params;

  // DARK GUARD FIRST. No credentials → return WITHOUT touching the network.
  // Everything below (the only `fetch` in this module) is unreachable dark.
  const client = isBankingProviderConnectable(provider) ? resolveClient() : null;
  if (!client) {
    return {
      ok: false,
      reason: "not_configured",
      message: `${provider} bank feed is not configured; no token exchange is possible.`,
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
  // The client secret goes in the HTTP Basic Authorization header, never in a
  // log line or the URL.
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

  // Resolve the connection handle from the aggregator (not a callback query
  // param — TrueLayer does not echo one). For TrueLayer this is a `/data/v1/me`
  // call with the fresh access token; other providers carry the ref on the
  // callback query, so we fall back to it. Guarded (connectable) + after the
  // exchange fetch, so still unreachable dark.
  const resolved = await resolveConnectionHandle({
    provider,
    accessToken: json.access_token,
  });

  return {
    ok: true,
    tokens: {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt,
      connectionRef: resolved.connectionRef ?? connectionRef ?? null,
      institutionId: resolved.institutionId,
      institutionName: resolved.institutionName,
    },
  };
}

/**
 * Refresh an access token via `grant_type=refresh_token`. REFUSES (no `fetch`)
 * when the provider is not connectable — the dark path is structural. On success
 * returns fresh tokens; when the aggregator does not rotate the refresh token,
 * the caller's existing refresh token is preserved. No connection handle is
 * re-resolved (the connection is unchanged), and no secret is ever logged.
 */
export async function refreshAccessToken(params: {
  provider: BankingProvider;
  refreshToken: string;
}): Promise<ExchangeResult> {
  const { provider, refreshToken } = params;

  // DARK GUARD FIRST. No credentials → return WITHOUT touching the network.
  const client = isBankingProviderConnectable(provider) ? resolveClient() : null;
  if (!client) {
    return {
      ok: false,
      reason: "not_configured",
      message: `${provider} bank feed is not configured; no token refresh is possible.`,
    };
  }

  const cfg = PROVIDER_OAUTH[provider];
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: client.clientId,
  });
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
      message: `token refresh request failed: ${e instanceof Error ? e.message : "network error"}`,
    };
  }

  if (!res.ok) {
    // invalid_grant surfaces as 400/401/403 on the token endpoint: the refresh
    // token is revoked/expired and NO retry can recover it — re-consent required.
    // Any other status (5xx, 429, ...) is transient and left retriable.
    const terminal =
      res.status === 400 || res.status === 401 || res.status === 403;
    return {
      ok: false,
      reason: "error",
      message: `token refresh returned ${res.status}`,
      terminal,
    };
  }

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    // A 2xx with no token is a provider contract violation, not a dead grant —
    // treat as transient (retriable) rather than permanently stranding the org.
    return { ok: false, reason: "error", message: "token refresh returned no access token" };
  }

  const expiresAt =
    typeof json.expires_in === "number"
      ? new Date(Date.now() + json.expires_in * 1000).toISOString()
      : null;

  return {
    ok: true,
    tokens: {
      accessToken: json.access_token,
      // TrueLayer does not always rotate the refresh token — keep the old one
      // when none comes back so the connection stays refreshable.
      refreshToken: json.refresh_token ?? refreshToken,
      expiresAt,
      connectionRef: null,
      institutionId: null,
      institutionName: null,
    },
  };
}

/** The non-secret connection handle an aggregator resolves for a fresh token. */
export type ConnectionHandle = {
  connectionRef: string | null;
  institutionId: string | null;
  institutionName: string | null;
};

/**
 * Resolve the aggregator connection handle (institution + connection reference)
 * from a fresh access token. REFUSES (no `fetch`, all-null handle) when the
 * provider is not connectable — the dark path. For TrueLayer this is a
 * `/data/v1/me` call (the Data API's account-holder/credentials metadata); other
 * providers carry the handle on the callback query, so this returns all-null and
 * the caller falls back. A failed lookup returns all-null (never throws) so the
 * callback can refuse rather than write a handle-less `connected` row.
 */
export async function resolveConnectionHandle(params: {
  provider: BankingProvider;
  accessToken: string;
}): Promise<ConnectionHandle> {
  const { provider, accessToken } = params;
  const empty: ConnectionHandle = {
    connectionRef: null,
    institutionId: null,
    institutionName: null,
  };

  // DARK GUARD FIRST + TrueLayer-only resolution. Non-TrueLayer providers do not
  // resolve here; the exchange falls back to the callback-carried ref.
  if (provider !== "truelayer") return empty;
  if (!isBankingProviderConnectable(provider)) return empty;

  let res: Response;
  try {
    res = await fetch("https://api.truelayer.com/data/v1/me", {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    });
  } catch {
    return empty;
  }
  if (!res.ok) return empty;

  const json = (await res.json()) as {
    results?: Array<{
      credentials_id?: string | null;
      provider?: { provider_id?: string | null; display_name?: string | null } | null;
    }>;
  };
  const first = json.results?.[0];
  if (!first) return empty;
  return {
    connectionRef: first.credentials_id ?? null,
    institutionId: first.provider?.provider_id ?? null,
    institutionName: first.provider?.display_name ?? null,
  };
}

/**
 * Decrypt-on-use seam. Tokens are stored as AES-256-GCM ciphertext (the callback
 * encrypts them before the DB write); this is the SINGLE place a future
 * statement-pull / refresh path turns them back into usable secrets, immediately
 * before an aggregator API call. `decryptToken` throws on a wrong key or any
 * tamper, so a corrupted token can never be silently used. Pure — no network.
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
