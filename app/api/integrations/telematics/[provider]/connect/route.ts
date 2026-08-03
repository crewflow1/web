import { NextResponse, type NextRequest } from "next/server";

import { requireOrgContext } from "@/server/auth/session";
import { buildAuthorizeUrl, TELEMATICS_PROVIDERS } from "@/lib/integrations/telematics/oauth";
import type { TelematicsProvider } from "@/lib/integrations/telematics/adapters";

/**
 * Telematics OAuth — CONNECT initiation. DARK (503).
 *
 * Starts the "connect your telematics account" flow via a fleet-telematics
 * aggregator: gate the caller (authenticated + org + admin), then ask the
 * aggregator-agnostic OAuth resolver for an authorize URL. When the provider is
 * not connectable — ALWAYS, today, because no aggregator credentials are set, no
 * TELEMATICS_PROVIDER is bound and NEXT_PUBLIC_FEATURE_TELEMATICS_CONNECT is off —
 * `buildAuthorizeUrl` REFUSES and this route returns a clean `not_configured` JSON
 * state with HTTP 503, WITHOUT redirecting anywhere and WITHOUT issuing PKCE
 * material.
 *
 * When live, it sets the PKCE `code_verifier` + anti-CSRF `state` as httpOnly
 * cookies (verified by the callback) and 302s the tenant to the aggregator. No
 * secret is ever logged.
 */

const VALID: readonly TelematicsProvider[] = TELEMATICS_PROVIDERS;

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

const STATE_COOKIE = (p: string) => `telem_oauth_state_${p}`;
const VERIFIER_COOKIE = (p: string) => `telem_oauth_verifier_${p}`;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider: providerRaw } = await params;
  if (!VALID.includes(providerRaw as TelematicsProvider)) {
    return NextResponse.json({ ok: false, error: "unknown_provider" }, { status: 404 });
  }
  const provider = providerRaw as TelematicsProvider;

  // Auth + org gate (redirects to /login or /onboarding when absent).
  const { ctx } = await requireOrgContext();
  // Admin gate — connecting a telematics account is an admin act. The DB RLS on
  // telematics_connections is the real boundary for any write; this is the
  // surface-level refusal so a non-admin never even starts the flow.
  if (!isAdminRole(ctx.membership.role)) {
    return NextResponse.json(
      { ok: false, error: "forbidden", message: "Only an owner or admin may connect a telematics account." },
      { status: 403 },
    );
  }

  const redirectUri = `${new URL(request.url).origin}/api/integrations/telematics/${provider}/callback`;
  const authorize = buildAuthorizeUrl(provider, redirectUri);

  // DARK: not configured → 503, no redirect, no cookies.
  if (!authorize.ok) {
    return NextResponse.json(
      {
        ok: false,
        provider,
        status: "not_configured",
        message: authorize.message,
      },
      { status: 503 },
    );
  }

  // LIVE (unreachable dark): persist PKCE + state, redirect to the aggregator.
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
