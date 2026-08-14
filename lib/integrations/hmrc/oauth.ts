import "server-only";
import { createHash, randomBytes } from "node:crypto";

import { decryptToken } from "@/lib/integrations/token-crypto";

/**
 * HMRC MTD OAuth — the CONNECT substrate for UK Making Tax Digital. DARK.
 *
 * This module is the OAuth half of "connect your HMRC account" for MTD VAT and
 * CIS. It resolves HMRC's OAuth2 client credentials from the environment, builds
 * the authorize-URL (PKCE) a tenant is redirected to, and exchanges the returned
 * code for tokens. Every step is credential-gated by a two-switch guard.
 *
 * ── LEGAL BOUNDARY ──────────────────────────────────────────────────────────
 * Connecting is not filing. Even once this OAuth flow is live, HMRC will not
 * accept a VAT/CIS submission from software it has not RECOGNISED (a legal /
 * commercial vendor-recognition gate + fraud-prevention-header conformance).
 * This module therefore only ever obtains the tokens a *recognised* client would
 * use; it contains NO submission call, and the wider substrate stops at
 * "prepared/held" (see lib/integrations/hmrc/vat-return.ts / cis-return.ts and
 * the 20261099 migration). There is no code path from here to a filed return.
 *
 * ── THE DARK-BY-DEFAULT INVARIANT (two-switch) ──────────────────────────────
 * `isHmrcConnectable()` is a pure env read: true ONLY when BOTH the HMRC client
 * id and client secret are present AND the NEXT_PUBLIC_FEATURE_HMRC_CONNECT flag
 * is on — which is NEVER, today. Credentials alone (e.g. a stray env leak) do
 * not open the flow; the flag is the deliberate second switch. When not
 * connectable:
 *   - buildAuthorizeUrl REFUSES (returns { ok:false, reason:'not_configured' })
 *     WITHOUT constructing a URL and WITHOUT issuing PKCE material, and
 *   - exchangeCodeForTokens REFUSES the same way WITHOUT any `fetch`.
 * There is no path from "no credentials" to an HMRC network call or a stored
 * token. The token-exchange `fetch` lives strictly AFTER the connectable guard,
 * so it is structurally unreachable dark. The security suite proves this against
 * this source.
 *
 * ── ACTIVATION ──────────────────────────────────────────────────────────────
 * Set HMRC_CLIENT_ID + HMRC_CLIENT_SECRET, flip NEXT_PUBLIC_FEATURE_HMRC_CONNECT,
 * AND complete HMRC vendor recognition. The redirect URI is derived per-request
 * from the request origin (origin-pin it to a trusted host at activation).
 * Secrets are read here and NEVER logged.
 */

/**
 * The MTD API families this connection can authorize. The route is keyed by
 * `[flow]`; each flow selects the OAuth scope set, but all bind to the SAME
 * single hmrc_connections row per org (provider is fixed 'hmrc').
 */
export const HMRC_FLOWS = ["vat", "cis"] as const;
export type HmrcFlow = (typeof HMRC_FLOWS)[number];

export function isHmrcFlow(v: unknown): v is HmrcFlow {
  return typeof v === "string" && (HMRC_FLOWS as readonly string[]).includes(v);
}

const CLIENT_ID_ENV = "HMRC_CLIENT_ID";
const CLIENT_SECRET_ENV = "HMRC_CLIENT_SECRET";

/**
 * The master feature flag. Even WITH credentials the connect surface stays dark
 * until this is truthy — a second, deliberate switch so credentials alone cannot
 * silently open a live OAuth flow.
 */
export function hmrcConnectFeatureEnabled(): boolean {
  const v = process.env.NEXT_PUBLIC_FEATURE_HMRC_CONNECT;
  return v === "1" || v === "true";
}

function envValue(name: string): string | null {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** A pure env read — no network, never throws. Credentials present AND flag on. */
export function isHmrcConnectable(): boolean {
  if (!hmrcConnectFeatureEnabled()) return false;
  return envValue(CLIENT_ID_ENV) !== null && envValue(CLIENT_SECRET_ENV) !== null;
}

/** Resolve HMRC's OAuth client credentials, or null when absent (dark). */
function resolveClient(): { clientId: string; clientSecret: string } | null {
  const clientId = envValue(CLIENT_ID_ENV);
  const clientSecret = envValue(CLIENT_SECRET_ENV);
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * HMRC OAuth endpoints (production). Only ever contacted AFTER the connectable
 * guard. Per-flow scope: MTD VAT and CIS request different grants but share the
 * one connection.
 */
const HMRC_OAUTH = {
  authorizeUrl: "https://www.tax.service.gov.uk/oauth/authorize",
  tokenUrl: "https://api.service.hmrc.gov.uk/oauth/token",
} as const;

const FLOW_SCOPE: Record<HmrcFlow, string> = {
  vat: "read:vat write:vat",
  cis: "read:cis write:cis",
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
 * Build the authorize URL + PKCE challenge for a flow. REFUSES (no URL, no PKCE
 * material) when HMRC is not connectable — the dark path. The caller persists
 * `state` + `codeVerifier` (httpOnly cookies) and redirects to `url`.
 */
export function buildAuthorizeUrl(flow: HmrcFlow, redirectUri: string): AuthorizeResult {
  // DARK GUARD FIRST. Without client credentials (or with the flag off) we
  // return without minting any PKCE material or constructing a URL.
  const client = isHmrcConnectable() ? resolveClient() : null;
  if (!client) {
    return {
      ok: false,
      reason: "not_configured",
      message:
        "HMRC is not configured. Set HMRC_CLIENT_ID + HMRC_CLIENT_SECRET and " +
        "enable NEXT_PUBLIC_FEATURE_HMRC_CONNECT to enable the connection flow.",
    };
  }

  const state = base64url(randomBytes(32));
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash("sha256").update(codeVerifier).digest());

  const url = new URL(HMRC_OAUTH.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", FLOW_SCOPE[flow]);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  return { ok: true, challenge: { url: url.toString(), state, codeVerifier } };
}

/** Tokens returned by a successful exchange (unreachable dark). */
export type HmrcTokens = {
  accessToken: string;
  refreshToken: string | null;
  /** Absolute expiry, ISO 8601. */
  expiresAt: string | null;
};

export type ExchangeResult =
  | { ok: true; tokens: HmrcTokens }
  | { ok: false; reason: "not_configured" | "error"; message: string };

/**
 * Exchange an authorization code for tokens. REFUSES (no `fetch`) when HMRC is
 * not connectable — the dark path is structural: the network call below is
 * unreachable without client credentials + the feature flag.
 */
export async function exchangeCodeForTokens(params: {
  flow: HmrcFlow;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<ExchangeResult> {
  const { code, codeVerifier, redirectUri } = params;

  // DARK GUARD FIRST. No credentials/flag → return WITHOUT touching the network.
  // Everything below (the only `fetch` in this module) is unreachable dark.
  const client = isHmrcConnectable() ? resolveClient() : null;
  if (!client) {
    return {
      ok: false,
      reason: "not_configured",
      message: "HMRC is not configured; no token exchange is possible.",
    };
  }

  // HMRC's token endpoint takes the client secret in the form body (not Basic).
  // The secret goes in the body, never in a log line or the URL.
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });

  const outcome = await postTokenRequest(body);
  if (!outcome.ok) {
    return { ok: false, reason: "error", message: outcome.message };
  }
  return { ok: true, tokens: outcome.tokens };
}

export type RefreshResult =
  | { ok: true; tokens: HmrcTokens }
  | {
      ok: false;
      reason: "not_configured" | "error";
      /**
       * TERMINAL — the stored refresh token is dead (HMRC answered the token
       * endpoint with invalid_grant, surfaced as 400/401/403). No retry recovers
       * it; the org must re-consent. Absent/false ⇒ a TRANSIENT blip (5xx / 429 /
       * network / a 2xx contract violation) that leaves the connection live to
       * self-heal on the next attempt. Mirrors the calendar refresh contract.
       */
      terminal?: boolean;
      message: string;
    };

/**
 * Refresh an HMRC access token with a stored refresh token
 * (`grant_type=refresh_token`). This is the LIVE token-refresh path the submit
 * pipeline calls on a 401 (or a near-expiry access token) so a connected org
 * renews silently without a fresh OAuth consent.
 *
 * REFUSES (no `fetch`) when HMRC is not connectable — structurally dark without
 * client credentials + the feature flag. HMRC MAY rotate the refresh token; when
 * it omits one on the response the caller keeps the existing refresh token (the
 * `refreshToken` field is then null). The secret goes in the body, never a log.
 */
export async function refreshAccessTokens(params: {
  refreshToken: string;
}): Promise<RefreshResult> {
  const { refreshToken } = params;

  // DARK GUARD FIRST. No credentials/flag → return WITHOUT touching the network.
  const client = isHmrcConnectable() ? resolveClient() : null;
  if (!client) {
    return {
      ok: false,
      reason: "not_configured",
      message: "HMRC is not configured; no token refresh is possible.",
    };
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: client.clientId,
    client_secret: client.clientSecret,
  });

  const outcome = await postTokenRequest(body);
  if (!outcome.ok) {
    // invalid_grant surfaces as 400/401/403 on the token endpoint: the refresh
    // token is revoked/expired and NO retry recovers it (re-consent required =
    // TERMINAL). Any other status (5xx / 429 / network) is transient.
    const terminal =
      outcome.status === 400 || outcome.status === 401 || outcome.status === 403;
    return { ok: false, reason: "error", message: outcome.message, terminal };
  }
  return {
    ok: true,
    tokens: {
      accessToken: outcome.tokens.accessToken,
      // HMRC may omit a rotated refresh token — keep the existing one so the
      // connection is not stranded without a refresh credential.
      refreshToken: outcome.tokens.refreshToken ?? refreshToken,
      expiresAt: outcome.tokens.expiresAt,
    },
  };
}

/**
 * Decrypt-on-use seam. Tokens are stored as AES-256-GCM ciphertext (the callback
 * encrypts them before the DB write); this is the SINGLE place a future live
 * refresh path turns them back into usable secrets. `decryptToken` throws on a
 * wrong key or any tamper, so a corrupted token can never be silently used.
 * Nobody calls this while dark; it is wired at activation.
 */
export function decryptStoredTokens(stored: {
  accessToken: string;
  refreshToken: string | null;
}): { accessToken: string; refreshToken: string | null } {
  return {
    accessToken: decryptToken(stored.accessToken),
    refreshToken: stored.refreshToken !== null ? decryptToken(stored.refreshToken) : null,
  };
}

/** Outcome of a raw POST to HMRC's OAuth token endpoint. Carries the status so the caller can classify terminal vs transient. */
type TokenPostOutcome =
  | { ok: true; tokens: HmrcTokens }
  | { ok: false; status: number | null; message: string };

/**
 * The SINGLE HMRC token-endpoint `fetch` in this module — shared by the
 * authorization-code exchange and the refresh path so there is exactly one
 * network call site (and it lives strictly AFTER every connectable guard, so it
 * is structurally unreachable while dark). The client secret rides in the form
 * body; neither it nor the returned tokens are ever logged. Response bodies are
 * NOT echoed wholesale — only a coarse status is surfaced.
 */
async function postTokenRequest(body: URLSearchParams): Promise<TokenPostOutcome> {
  let res: Response;
  try {
    res = await fetch(HMRC_OAUTH.tokenUrl, {
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
      status: null,
      message: `token request failed: ${e instanceof Error ? e.message : "network error"}`,
    };
  }

  if (!res.ok) {
    // Do NOT echo the response body wholesale — it can carry sensitive detail.
    return { ok: false, status: res.status, message: `token request returned ${res.status}` };
  }

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
    return { ok: false, status: res.status, message: "token request returned no access token" };
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
    },
  };
}
