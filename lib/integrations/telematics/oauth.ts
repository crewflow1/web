import "server-only";
import { createHash, randomBytes } from "node:crypto";

import { decryptToken } from "@/lib/integrations/token-crypto";

import type { TelematicsProvider } from "./adapters";

/**
 * Telematics OAuth — the GPS / fleet-telematics aggregator CONNECT substrate. DARK.
 *
 * This module is the OAuth half of "connect your telematics account" via a fleet
 * telematics aggregator (Samsara / Verizon Connect). It resolves the aggregator's
 * OAuth client credentials from the environment, builds the authorize URL (PKCE) a
 * tenant is redirected to, and exchanges the returned code for tokens. Every one
 * of those steps is credential-gated.
 *
 * ── THE DARK-BY-DEFAULT INVARIANT ───────────────────────────────────────────
 * `isTelematicsProviderConnectable(p)` is a pure env read: true only when ALL of
 *   - NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT is on (switch 1),
 *   - TELEMATICS_CLIENT_ID and TELEMATICS_CLIENT_SECRET are present (switch 2), AND
 *   - the requested provider equals the bound TELEMATICS_PROVIDER,
 * hold — which is NEVER, today. When a provider is not connectable:
 *   - buildAuthorizeUrl REFUSES (returns { ok:false, reason:'not_configured' })
 *     WITHOUT constructing a URL and WITHOUT issuing PKCE material, and
 *   - exchangeCodeForTokens REFUSES the same way WITHOUT any `fetch`.
 * There is no code path from "no credentials" to an aggregator network call or a
 * stored token. The token-exchange `fetch` lives strictly AFTER the connectable
 * guard, so it is structurally unreachable dark. The security suite proves this
 * against this source.
 *
 * ── ACTIVATION (config + a CEO provider choice, not engineering) ────────────
 * After a telematics provider account is opened and a CEO / product decision
 * binds ONE aggregator:
 *   TELEMATICS_PROVIDER         → 'samsara' | 'verizon_connect' (bind one)
 *   TELEMATICS_CLIENT_ID        → the aggregator OAuth client id
 *   TELEMATICS_CLIENT_SECRET    → the aggregator OAuth client secret
 *   NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT="true"
 *   INTEGRATION_TOKEN_ENCRYPTION_KEY (shared) — so tokens are encrypted at rest.
 * No code change reaches the live path. The redirect URI is derived per-request
 * from the request origin; it MUST be origin-pinned to a trusted allow-listed
 * host at activation. Secrets are read here and NEVER logged.
 */

/** The aggregators this substrate can bind an org to. A small, closed set. */
export type { TelematicsProvider } from "./adapters";
export const TELEMATICS_PROVIDERS: readonly TelematicsProvider[] = [
  "samsara",
  "verizon_connect",
];

/**
 * The master feature flag (switch 1). Even WITH credentials the connect surface
 * stays dark until this is truthy — a second, deliberate switch so credentials
 * alone (e.g. a stray env leak) cannot silently open a live OAuth flow.
 */
export function telematicsConnectFeatureEnabled(): boolean {
  return process.env.NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT === "true";
}

function envValue(name: string): string | null {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Which single aggregator this deployment is bound to, or null when unbound.
 * Telematics uses ONE OAuth client + an explicit TELEMATICS_PROVIDER binding: an
 * unbound deployment connects to nothing. A pure env read; never throws.
 */
export function resolveActiveTelematicsProvider(): TelematicsProvider | null {
  const v = envValue("TELEMATICS_PROVIDER");
  if (v === null) return null;
  return (TELEMATICS_PROVIDERS as readonly string[]).includes(v)
    ? (v as TelematicsProvider)
    : null;
}

/**
 * A pure env read — no network, never throws. A provider is connectable only when
 * the feature flag is on, the OAuth client credentials are present, AND that
 * provider is the bound TELEMATICS_PROVIDER. False for every provider today.
 */
export function isTelematicsProviderConnectable(provider: TelematicsProvider): boolean {
  if (!telematicsConnectFeatureEnabled()) return false;
  if (resolveActiveTelematicsProvider() !== provider) return false;
  return (
    envValue("TELEMATICS_CLIENT_ID") !== null &&
    envValue("TELEMATICS_CLIENT_SECRET") !== null
  );
}

/** Resolve the OAuth client credentials, or null when absent (dark). */
function resolveClient(): { clientId: string; clientSecret: string } | null {
  const clientId = envValue("TELEMATICS_CLIENT_ID");
  const clientSecret = envValue("TELEMATICS_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Aggregator OAuth endpoints. Only ever contacted AFTER the connectable guard.
 * These are the documented aggregator endpoints; they are wired at activation and
 * are unreachable while dark.
 */
const PROVIDER_OAUTH: Record<
  TelematicsProvider,
  { authorizeUrl: string; tokenUrl: string; scope: string }
> = {
  samsara: {
    authorizeUrl: "https://api.samsara.com/oauth2/authorize",
    tokenUrl: "https://api.samsara.com/oauth2/token",
    scope: "read:vehicles read:vehicle-locations read:vehicle-stats",
  },
  verizon_connect: {
    // Verizon Connect Reveal's OAuth handshake differs in detail; these are the
    // seam endpoints wired at activation behind the connectable guard.
    authorizeUrl: "https://fim.api.us.fleetmatics.com/token/authorize",
    tokenUrl: "https://fim.api.us.fleetmatics.com/token",
    scope: "vehicles location odometer",
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
  provider: TelematicsProvider,
  redirectUri: string,
): AuthorizeResult {
  // DARK GUARD FIRST. Without client credentials (flag off / provider unbound)
  // we return without minting any PKCE material or constructing a URL.
  const client = isTelematicsProviderConnectable(provider) ? resolveClient() : null;
  if (!client) {
    return {
      ok: false,
      reason: "not_configured",
      message:
        `${provider} telematics feed is not configured. Open a telematics provider ` +
        `account, set the aggregator OAuth client credentials, bind ` +
        `TELEMATICS_PROVIDER and enable NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT to ` +
        `enable the connection flow.`,
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
  /** The telematics provider account id (Samsara org id / Verizon account id). */
  externalAccountId: string | null;
};

export type ExchangeResult =
  | { ok: true; tokens: ProviderTokens }
  | { ok: false; reason: "not_configured" | "error"; message: string };

/**
 * Exchange an authorization code for tokens. REFUSES (no `fetch`) when the
 * provider is not connectable — the dark path is structural: the network call
 * below is unreachable without client credentials. The provider account id is
 * carried on the callback query, so the caller passes it in.
 */
export async function exchangeCodeForTokens(params: {
  provider: TelematicsProvider;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  externalAccountId?: string | null;
}): Promise<ExchangeResult> {
  const { provider, code, codeVerifier, redirectUri, externalAccountId } = params;

  // DARK GUARD FIRST. No credentials → return WITHOUT touching the network.
  // Everything below (the only `fetch` in this module) is unreachable dark.
  const client = isTelematicsProviderConnectable(provider) ? resolveClient() : null;
  if (!client) {
    return {
      ok: false,
      reason: "not_configured",
      message: `${provider} telematics feed is not configured; no token exchange is possible.`,
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

  return {
    ok: true,
    tokens: {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresAt,
      // The provider account is resolved via a follow-up call at activation; the
      // account id is carried on the callback query.
      externalAccountId: externalAccountId ?? null,
    },
  };
}

/**
 * Decrypt-on-use seam. Tokens are stored as AES-256-GCM ciphertext (the callback
 * encrypts them before the DB write); this is the SINGLE place a future
 * reading-pull / refresh path turns them back into usable secrets, immediately
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
