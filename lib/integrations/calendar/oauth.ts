import "server-only";
import { createHash, randomBytes } from "node:crypto";

/**
 * Calendar OAuth — the provider-agnostic CONNECT substrate. DARK.
 *
 * This module is the OAuth half of "connect your Google / Microsoft calendar".
 * It resolves a provider's OAuth client credentials from the environment, builds
 * the authorize-URL (PKCE) a tenant is redirected to, and exchanges the returned
 * code for tokens. Every one of those steps is credential-gated.
 *
 * ── THE DARK-BY-DEFAULT INVARIANT ───────────────────────────────────────────
 * `isGoogleCalendarConnectable()` / `isMicrosoftCalendarConnectable()` are pure
 * env reads: true only when the FEATURE_CALENDAR_CONNECT flag is on AND both the
 * client id and client secret are present and non-empty — which is NEVER, today.
 * When a provider is not connectable:
 *   - buildAuthorizeUrl REFUSES (returns { ok:false, reason:'not_configured' })
 *     WITHOUT constructing a URL and WITHOUT issuing PKCE material, and
 *   - exchangeCodeForTokens REFUSES the same way WITHOUT any `fetch`.
 * There is no code path from "no credentials" to a provider network call or a
 * stored token. The token-exchange `fetch` lives strictly AFTER the connectable
 * guard, so it is structurally unreachable dark. The security suite proves this
 * against this source.
 *
 * ── CALENDAR-ONLY SCOPES ────────────────────────────────────────────────────
 * Google requests `https://www.googleapis.com/auth/calendar.events`; Microsoft
 * `Calendars.ReadWrite offline_access`. NO mail scopes are requested. The
 * Microsoft client is a SEPARATE OAuth app from the auth-only Azure SSO
 * (NEXT_PUBLIC_FEATURE_MICROSOFT_SSO) — this is a Graph calendar token, NOT a
 * sign-in token — so it reads its own MS_GRAPH_* credentials, never the SSO ones.
 *
 * ── ACTIVATION ──────────────────────────────────────────────────────────────
 * Set the provider's client credentials (below), then flip FEATURE_CALENDAR_CONNECT.
 * No code change is required to reach the live path:
 *   Google     → GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET
 *   Microsoft  → MS_GRAPH_CLIENT_ID,        MS_GRAPH_CLIENT_SECRET
 * The redirect URI is derived per-request from the request origin, so no extra
 * env is needed for it (it MUST be origin-pinned to an allow-listed host at
 * activation — see the migration note). Secrets are read here and NEVER logged.
 */

export type CalendarProvider = "google" | "microsoft";

export const CALENDAR_PROVIDERS: readonly CalendarProvider[] = ["google", "microsoft"];

/** The env var names whose presence makes a provider connectable. Client id + secret. */
const PROVIDER_ENV: Record<
  CalendarProvider,
  { clientId: string; clientSecret: string }
> = {
  google: {
    clientId: "GOOGLE_CALENDAR_CLIENT_ID",
    clientSecret: "GOOGLE_CALENDAR_CLIENT_SECRET",
  },
  // A SEPARATE Graph app from the auth-only Azure SSO — never the SSO creds.
  microsoft: {
    clientId: "MS_GRAPH_CLIENT_ID",
    clientSecret: "MS_GRAPH_CLIENT_SECRET",
  },
};

/**
 * The master feature flag. Even WITH credentials the connect surface stays dark
 * until this is truthy — a second, deliberate switch so credentials alone (e.g.
 * a stray env leak) cannot silently open a live OAuth flow.
 */
export function calendarConnectFeatureEnabled(): boolean {
  const v = process.env.FEATURE_CALENDAR_CONNECT;
  return v === "1" || v === "true";
}

function envValue(name: string): string | null {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** A pure env read — no network, never throws. Credentials present AND flag on. */
export function isCalendarProviderConnectable(provider: CalendarProvider): boolean {
  if (!calendarConnectFeatureEnabled()) return false;
  const keys = PROVIDER_ENV[provider];
  return envValue(keys.clientId) !== null && envValue(keys.clientSecret) !== null;
}

export function isGoogleCalendarConnectable(): boolean {
  return isCalendarProviderConnectable("google");
}

export function isMicrosoftCalendarConnectable(): boolean {
  return isCalendarProviderConnectable("microsoft");
}

/** Resolve a provider's OAuth client credentials, or null when absent (dark). */
function resolveClient(
  provider: CalendarProvider,
): { clientId: string; clientSecret: string } | null {
  const keys = PROVIDER_ENV[provider];
  const clientId = envValue(keys.clientId);
  const clientSecret = envValue(keys.clientSecret);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Provider OAuth endpoints + CALENDAR-ONLY scopes. Only ever contacted AFTER the
 * connectable guard. `offline_access` (Microsoft) / `access_type=offline`
 * (Google) yields a refresh token so the push adapter can renew without a
 * re-consent. NO mail scope appears here.
 */
const PROVIDER_OAUTH: Record<
  CalendarProvider,
  { authorizeUrl: string; tokenUrl: string; scope: string }
> = {
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/calendar.events",
  },
  microsoft: {
    authorizeUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope: "Calendars.ReadWrite offline_access",
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
  provider: CalendarProvider,
  redirectUri: string,
): AuthorizeResult {
  // DARK GUARD FIRST. Without client credentials (or with the flag off) we
  // return without minting any PKCE material or constructing a URL.
  const client = isCalendarProviderConnectable(provider) ? resolveClient(provider) : null;
  if (!client) {
    return {
      ok: false,
      reason: "not_configured",
      message:
        `${provider} calendar is not configured. Set its OAuth client ` +
        `credentials and enable FEATURE_CALENDAR_CONNECT to enable the ` +
        `connection flow.`,
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
  // Ask for a refresh token so the push adapter can renew silently. Google needs
  // access_type=offline (+ consent prompt to re-issue); Microsoft carries it in
  // the offline_access scope already.
  if (provider === "google") {
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
  }

  return { ok: true, challenge: { url: url.toString(), state, codeVerifier } };
}

/** Tokens returned by a successful exchange (unreachable dark). */
export type ProviderTokens = {
  accessToken: string;
  refreshToken: string | null;
  /** Absolute expiry, ISO 8601. */
  expiresAt: string | null;
  /** Provider account handle: resolved via a follow-up userinfo/me call at activation. */
  externalAccountId: string | null;
};

export type ExchangeResult =
  | { ok: true; tokens: ProviderTokens }
  | { ok: false; reason: "not_configured" | "error"; message: string };

/**
 * Exchange an authorization code for tokens. REFUSES (no `fetch`) when the
 * provider is not connectable — the dark path is structural: the network call
 * below is unreachable without client credentials.
 */
export async function exchangeCodeForTokens(params: {
  provider: CalendarProvider;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<ExchangeResult> {
  const { provider, code, codeVerifier, redirectUri } = params;

  // DARK GUARD FIRST. No credentials → return WITHOUT touching the network.
  // Everything below (the only `fetch` in this module) is unreachable dark.
  const client = isCalendarProviderConnectable(provider) ? resolveClient(provider) : null;
  if (!client) {
    return {
      ok: false,
      reason: "not_configured",
      message: `${provider} calendar is not configured; no token exchange is possible.`,
    };
  }

  const cfg = PROVIDER_OAUTH[provider];
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });

  let res: Response;
  try {
    res = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
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
      // The account handle is resolved via a follow-up userinfo (Google) / /me
      // (Microsoft Graph) call, wired at activation. Null from the exchange alone.
      externalAccountId: null,
    },
  };
}
