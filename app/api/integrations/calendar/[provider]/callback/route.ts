import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  exchangeCodeForTokens,
  isCalendarProviderConnectable,
  CALENDAR_PROVIDERS,
  type CalendarProvider,
} from "@/lib/integrations/calendar/oauth";

/**
 * Calendar OAuth — CONNECT callback. DARK.
 *
 * The provider redirects here with `?code=&state=`. This route:
 *   1. gates the caller (authenticated + org + admin),
 *   2. verifies the `state` echoed back matches the httpOnly cookie the connect
 *      route set (anti-CSRF),
 *   3. exchanges the code for tokens — ONLY when the provider is connectable —
 *      and upserts the connection row.
 *
 * DARK INVARIANT. `isCalendarProviderConnectable` is false today (no client
 * credentials, FEATURE_CALENDAR_CONNECT off), so this route short-circuits BEFORE
 * `exchangeCodeForTokens` is ever called — no `fetch`, no token, no `connected`
 * row is written. The exchange (the only network call) is structurally
 * unreachable dark. Tokens, once live, are encrypted application-side before they
 * reach the DB (see the migration's "TOKENS AT REST" note); this build writes
 * none. No secret is ever logged.
 */

const VALID: readonly CalendarProvider[] = CALENDAR_PROVIDERS;

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

const STATE_COOKIE = (p: string) => `cal_oauth_state_${p}`;
const VERIFIER_COOKIE = (p: string) => `cal_oauth_verifier_${p}`;

/**
 * Clear the single-use PKCE/state cookies on the callback response. Once a
 * callback has consumed a state+verifier pair it must not be replayable within
 * the 600s cookie window, so both are expired (maxAge 0, matching the path they
 * were set with) on every response that leaves this route after the dark guard.
 */
function clearOAuthCookies(res: NextResponse, provider: string): void {
  const expire = { path: "/", maxAge: 0 } as const;
  res.cookies.set(STATE_COOKIE(provider), "", expire);
  res.cookies.set(VERIFIER_COOKIE(provider), "", expire);
}

function backToSettings(origin: string, status: string, provider: string): NextResponse {
  const u = new URL(`${origin}/settings/integrations`);
  u.searchParams.set("connect", status);
  const res = NextResponse.redirect(u);
  clearOAuthCookies(res, provider);
  return res;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider: providerRaw } = await params;
  if (!VALID.includes(providerRaw as CalendarProvider)) {
    return NextResponse.json({ ok: false, error: "unknown_provider" }, { status: 404 });
  }
  const provider = providerRaw as CalendarProvider;
  const { origin, searchParams } = new URL(request.url);

  // Auth + org + admin gate — a callback still writes tenant state, so it is
  // gated exactly like the initiation.
  const { ctx, user } = await requireOrgContext();
  if (!isAdminRole(ctx.membership.role)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  // DARK SHORT-CIRCUIT. Not connectable → do NOT exchange anything. This is the
  // structural guarantee: the token exchange below is unreachable without
  // provider client credentials + the feature flag.
  if (!isCalendarProviderConnectable(provider)) {
    return NextResponse.json(
      {
        ok: false,
        provider,
        status: "not_configured",
        message: `${provider} calendar is not configured; the connection was not completed.`,
      },
      { status: 200 },
    );
  }

  // ── LIVE PATH (unreachable dark) ────────────────────────────────────────────
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  // Anti-CSRF: the state echoed back must match the cookie the connect route set.
  const stateCookie = request.cookies.get(STATE_COOKIE(provider))?.value ?? null;
  const verifier = request.cookies.get(VERIFIER_COOKIE(provider))?.value ?? null;
  if (!code || !state || !stateCookie || state !== stateCookie || !verifier) {
    return backToSettings(origin, "state_mismatch", provider);
  }

  const redirectUri = `${origin}/api/integrations/calendar/${provider}/callback`;
  const exchanged = await exchangeCodeForTokens({
    provider,
    code,
    codeVerifier: verifier,
    redirectUri,
  });

  if (!exchanged.ok) {
    return backToSettings(origin, "error", provider);
  }

  const handle = exchanged.tokens.externalAccountId;
  if (!handle) {
    // The DB CHECK forbids a connected row without an account handle; refuse
    // rather than write an invalid row.
    return backToSettings(origin, "no_account", provider);
  }

  const supabase = await createClient();
  // calendar_connections post-dates the generated types.ts; cast to a minimal
  // upsert builder. RLS (admin-write) is the real authorisation for this write.
  const loose = supabase as unknown as {
    from: (t: string) => {
      upsert: (
        row: Record<string, unknown>,
        opts: { onConflict: string },
      ) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
  const { error } = await loose.from("calendar_connections").upsert(
    {
      org_id: ctx.org.id,
      provider,
      status: "connected",
      external_account_id: handle,
      // Encrypted application-side at activation (see migration note); this
      // build never reaches here.
      access_token: exchanged.tokens.accessToken,
      refresh_token: exchanged.tokens.refreshToken,
      token_expires_at: exchanged.tokens.expiresAt,
      connected_by: user.id,
      connected_at: new Date().toISOString(),
      last_error: null,
    },
    { onConflict: "org_id,provider" },
  );
  if (error) {
    // Never log the token payload — only a coarse failure signal.
    console.error("[calendar] connection upsert failed", { provider, message: error.message });
    return backToSettings(origin, "error", provider);
  }

  return backToSettings(origin, "connected", provider);
}
