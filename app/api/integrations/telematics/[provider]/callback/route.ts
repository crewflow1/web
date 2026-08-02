import { timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  exchangeCodeForTokens,
  isTelematicsProviderConnectable,
  TELEMATICS_PROVIDERS,
} from "@/lib/integrations/telematics/oauth";
import {
  encryptToken,
  isTokenEncryptionConfigured,
} from "@/lib/integrations/token-crypto";
import type { TelematicsProvider } from "@/lib/integrations/telematics/adapters";

/**
 * Telematics OAuth — CONNECT callback. DARK (503).
 *
 * The aggregator redirects here with `?code=&state=`. This route:
 *   1. gates the caller (authenticated + org + admin),
 *   2. verifies the `state` echoed back matches the httpOnly cookie the connect
 *      route set (anti-CSRF, constant-time),
 *   3. exchanges the code for tokens — ONLY when the provider is connectable —
 *      and upserts the connection row (tokens encrypted before write).
 *
 * DARK INVARIANT. `isTelematicsProviderConnectable` is false today (no
 * credentials, no bound provider, flag off), so this route short-circuits BEFORE
 * `exchangeCodeForTokens` is ever called — returning 503, with no `fetch`, no
 * token and no `connected` row written. The exchange (the only network call) is
 * structurally unreachable dark. Tokens, once live, are AES-256-GCM encrypted
 * application-side before they reach the DB (the token-crypto tripwire enforces
 * this); this build writes none. No secret is ever logged.
 */

const VALID: readonly TelematicsProvider[] = TELEMATICS_PROVIDERS;

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Constant-time comparison of the echoed `state` against the cookie. A length
 * check first (timingSafeEqual throws on unequal lengths), then the timing-safe
 * compare — a mismatch leaks no timing signal. Never a bare `===`/`!==` string
 * compare on a security token.
 */
function stateMatches(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const STATE_COOKIE = (p: string) => `telem_oauth_state_${p}`;
const VERIFIER_COOKIE = (p: string) => `telem_oauth_verifier_${p}`;

/**
 * Clear the single-use PKCE/state cookies on the callback response. Once a
 * callback has consumed a state+verifier pair it must not be replayable within the
 * 600s cookie window, so both are expired (maxAge 0) on every response that leaves
 * this route after the dark guard.
 */
function clearOAuthCookies(res: NextResponse, provider: string): void {
  const expire = { path: "/", maxAge: 0 } as const;
  res.cookies.set(STATE_COOKIE(provider), "", expire);
  res.cookies.set(VERIFIER_COOKIE(provider), "", expire);
}

function backToIntegrations(origin: string, status: string, provider: string): NextResponse {
  const u = new URL(`${origin}/settings/integrations`);
  u.searchParams.set("telematics", status);
  const res = NextResponse.redirect(u);
  clearOAuthCookies(res, provider);
  return res;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider: providerRaw } = await params;
  if (!VALID.includes(providerRaw as TelematicsProvider)) {
    return NextResponse.json({ ok: false, error: "unknown_provider" }, { status: 404 });
  }
  const provider = providerRaw as TelematicsProvider;
  const { origin, searchParams } = new URL(request.url);

  // Auth + org + admin gate — a callback still writes tenant state, so it is
  // gated exactly like the initiation.
  const { ctx, user } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // DARK SHORT-CIRCUIT. Not connectable → 503, do NOT exchange anything. This is
  // the structural guarantee: the token exchange below is unreachable without
  // aggregator credentials + the feature flag + a bound provider.
  if (!isTelematicsProviderConnectable(provider)) {
    return NextResponse.json(
      {
        ok: false,
        provider,
        status: "not_configured",
        message: `${provider} telematics feed is not configured; the connection was not completed.`,
      },
      { status: 503 },
    );
  }

  // TOKEN-ENCRYPTION TRIPWIRE. A connectable provider MUST have a valid token
  // encryption key, or we REFUSE the exchange and write NOTHING. This enforces
  // "no plaintext token is ever written" in code: the encrypt-before-write below
  // would throw without a key, so we fail loudly here — before any token exchange.
  // Dark today (no creds ⇒ never connectable), so this never triggers.
  if (!isTokenEncryptionConfigured()) {
    console.error("[telematics] refusing exchange: token encryption key missing", { provider });
    return NextResponse.json(
      {
        ok: false,
        provider,
        status: "encryption_not_configured",
        message:
          `${provider} cannot be connected: INTEGRATION_TOKEN_ENCRYPTION_KEY is ` +
          `not set. No token was requested or stored.`,
      },
      { status: 500 },
    );
  }

  // ── LIVE PATH (unreachable dark) ────────────────────────────────────────────
  const code = searchParams.get("code");
  const state = searchParams.get("state");
  // The provider account id is carried on the callback query.
  const externalAccountId = searchParams.get("account_id") ?? searchParams.get("org_id");

  // Anti-CSRF: the state echoed back must match the cookie the connect route set
  // (constant-time compare — never a bare string `!==` on a security token).
  const stateCookie = request.cookies.get(STATE_COOKIE(provider))?.value ?? null;
  const verifier = request.cookies.get(VERIFIER_COOKIE(provider))?.value ?? null;
  if (!code || !state || !stateCookie || !verifier || !stateMatches(state, stateCookie)) {
    return backToIntegrations(origin, "state_mismatch", provider);
  }

  const redirectUri = `${origin}/api/integrations/telematics/${provider}/callback`;
  const exchanged = await exchangeCodeForTokens({
    provider,
    code,
    codeVerifier: verifier,
    redirectUri,
    externalAccountId,
  });

  if (!exchanged.ok) {
    return backToIntegrations(origin, "error", provider);
  }

  const handle = exchanged.tokens.externalAccountId;
  if (!handle) {
    // The DB CHECK forbids a connected row without a connection handle; refuse
    // rather than write an invalid row.
    return backToIntegrations(origin, "no_account", provider);
  }

  const refreshToken = exchanged.tokens.refreshToken;
  const supabase = await createClient();
  // telematics_connections post-dates the generated types.ts; cast to a minimal
  // upsert builder. RLS (admin-write) is the real authorisation for this write.
  const loose = supabase as unknown as {
    from: (t: string) => {
      upsert: (
        row: Record<string, unknown>,
        opts: { onConflict: string },
      ) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
  const { error } = await loose.from("telematics_connections").upsert(
    {
      org_id: ctx.org.id,
      provider,
      status: "connected",
      external_account_id: exchanged.tokens.externalAccountId,
      // Tokens are AES-256-GCM encrypted application-side BEFORE they reach the
      // DB — the columns hold ciphertext, never a plaintext secret. The tripwire
      // above guarantees a key is present, so encryptToken cannot throw here.
      access_token: encryptToken(exchanged.tokens.accessToken),
      refresh_token: refreshToken === null ? null : encryptToken(refreshToken),
      token_expires_at: exchanged.tokens.expiresAt,
      connected_by: user.id,
      connected_at: new Date().toISOString(),
      last_error: null,
    },
    { onConflict: "org_id,provider" },
  );
  if (error) {
    // Never log the token payload — only a coarse failure signal.
    console.error("[telematics] connection upsert failed", { provider, message: error.message });
    return backToIntegrations(origin, "error", provider);
  }

  return backToIntegrations(origin, "connected", provider);
}
