import { NextResponse, type NextRequest } from "next/server";

import { requireOrgContext } from "@/server/auth/session";
import {
  buildAuthorizeUrl,
  CALENDAR_PROVIDERS,
  type CalendarProvider,
} from "@/lib/integrations/calendar/oauth";

/**
 * Calendar OAuth — CONNECT initiation. DARK.
 *
 * Starts the "connect your Google / Microsoft calendar" flow: gate the caller
 * (authenticated + org + admin), then ask the provider-agnostic OAuth resolver
 * for an authorize URL. When the provider is not connectable — ALWAYS, today,
 * because no client credentials are set and FEATURE_CALENDAR_CONNECT is off —
 * `buildAuthorizeUrl` REFUSES and this route returns a clean `not_configured`
 * JSON state WITHOUT redirecting anywhere and WITHOUT issuing PKCE material.
 *
 * When live, it sets the PKCE `code_verifier` + anti-CSRF `state` as httpOnly
 * cookies (verified by the callback) and 302s the tenant to the provider. No
 * secret is ever logged.
 */

const VALID: readonly CalendarProvider[] = CALENDAR_PROVIDERS;

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

const STATE_COOKIE = (p: string) => `cal_oauth_state_${p}`;
const VERIFIER_COOKIE = (p: string) => `cal_oauth_verifier_${p}`;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider: providerRaw } = await params;
  if (!VALID.includes(providerRaw as CalendarProvider)) {
    return NextResponse.json({ ok: false, error: "unknown_provider" }, { status: 404 });
  }
  const provider = providerRaw as CalendarProvider;

  // Auth + org gate (redirects to /login or /onboarding when absent).
  const { ctx } = await requireOrgContext();
  // Admin gate — connecting a calendar provider is an admin act. The DB RLS on
  // calendar_connections is the real boundary for any write; this is the
  // surface-level refusal so a non-admin never even starts the flow.
  if (!isAdminRole(ctx.membership.role)) {
    return NextResponse.json(
      { ok: false, error: "forbidden", message: "Only an owner or admin may connect a calendar provider." },
      { status: 403 },
    );
  }

  const redirectUri = `${new URL(request.url).origin}/api/integrations/calendar/${provider}/callback`;
  const authorize = buildAuthorizeUrl(provider, redirectUri);

  // DARK: not configured → return a clear state, no redirect, no cookies.
  if (!authorize.ok) {
    return NextResponse.json(
      {
        ok: false,
        provider,
        status: "not_configured",
        message: authorize.message,
      },
      { status: 200 },
    );
  }

  // LIVE (unreachable dark): persist PKCE + state, redirect to the provider.
  const res = NextResponse.redirect(authorize.challenge.url);
  const cookieOpts = {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600, // 10 minutes — the authorize round-trip window.
  };
  res.cookies.set(STATE_COOKIE(provider), authorize.challenge.state, cookieOpts);
  res.cookies.set(VERIFIER_COOKIE(provider), authorize.challenge.codeVerifier, cookieOpts);
  return res;
}
