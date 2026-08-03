import "server-only";

/**
 * Shared OAuth token-refresh — the provider-agnostic `grant_type=refresh_token`
 * POST every integration substrate reuses (accounting today; banking / calendar
 * / telematics follow the same token shape).
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * A single, pure HTTP helper: given a provider token endpoint + OAuth client
 * credentials + a refresh token, it exchanges the refresh token for a fresh
 * access token (and possibly a rotated refresh token). It reads NO environment,
 * touches NO database, and enforces NO darkness guard — those are the CALLER's
 * job. The accounting caller (lib/integrations/accounting/oauth.ts) performs the
 * `isProviderConnectable` guard BEFORE reaching this helper, so the `fetch`
 * below is only ever executed on the credentialed, flag-on path. Keeping the
 * network here (and the guard there) means the security source-scan on each
 * substrate still sees "the guard precedes the call".
 *
 * ── CLIENT AUTHENTICATION ────────────────────────────────────────────────────
 * Both Xero (identity.xero.com) and Intuit (oauth.platform.intuit.com) accept
 * HTTP Basic client authentication on the token endpoint, mirroring the
 * authorization_code exchange. The secret goes in the Authorization header,
 * never in the body, the URL, or a log line.
 */

/** Fresh tokens from a successful refresh. */
export type RefreshedTokens = {
  accessToken: string;
  /**
   * The rotated refresh token when the provider returns one, else null. A null
   * here means "the provider did not rotate it" — the caller keeps the existing
   * stored refresh token rather than nulling it.
   */
  refreshToken: string | null;
  /** Absolute expiry, ISO 8601, when the provider returned `expires_in`. */
  expiresAt: string | null;
};

export type RefreshResult =
  | { ok: true; tokens: RefreshedTokens }
  | { ok: false; reason: "error"; message: string };

/**
 * Exchange a refresh token for a fresh access token at a provider token endpoint.
 *
 * PURE + UNGUARDED. This makes a network call unconditionally — it is the
 * caller's responsibility to have passed the darkness guard first. A non-2xx
 * response, a network failure, or a missing access token maps to a coarse
 * `error` result; the provider response body is never echoed wholesale (it can
 * carry sensitive detail).
 */
export async function refreshOAuthToken(params: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<RefreshResult> {
  const { tokenUrl, clientId, clientSecret, refreshToken } = params;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  let res: Response;
  try {
    res = await fetch(tokenUrl, {
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
    // Never echo the response body wholesale — a failing refresh often carries
    // the invalid_grant detail that should not reach a log or a tenant surface.
    return { ok: false, reason: "error", message: `token refresh returned ${res.status}` };
  }

  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!json.access_token) {
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
      refreshToken: json.refresh_token ?? null,
      expiresAt,
    },
  };
}
