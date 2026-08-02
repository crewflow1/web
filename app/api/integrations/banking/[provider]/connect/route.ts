import { NextResponse, type NextRequest } from "next/server";

import { requireOrgContext } from "@/server/auth/session";
import { buildAuthorizeUrl, BANKING_PROVIDERS } from "@/lib/integrations/banking/oauth";
import type { BankingProvider } from "@/lib/integrations/banking/adapters";

/**
 * Banking OAuth — CONNECT initiation. DARK.
 *
 * Starts the "connect your bank" flow via an Open Banking aggregator: gate the
 * caller (authenticated + org + admin), then ask the aggregator-agnostic OAuth
 * resolver for an authorize URL. When the provider is not connectable — ALWAYS,
 * today, because no aggregator credentials are set, no BANKING_PROVIDER is bound
 * and NEXT_PUBLIC_FEATURE_BANKING_CONNECT is off — `buildAuthorizeUrl` REFUSES
 * and this route returns a clean `not_configured` JSON state WITHOUT redirecting
 * anywhere and WITHOUT issuing PKCE material.
 *
 * ── FCA LEGAL BOUNDARY ──────────────────────────────────────────────────────
 * Account Information Services are FCA-regulated. This route can never begin a
 * live bank connection before AISP authorisation exists — the dark refusal is
 * the technical guarantee.
 *
 * When live, it sets the PKCE `code_verifier` + anti-CSRF `state` as httpOnly
 * cookies (verified by the callback) and 302s the tenant to the aggregator. No
 * secret is ever logged.
 */

const VALID: readonly BankingProvider[] = BANKING_PROVIDERS;

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

const STATE_COOKIE = (p: string) => `bank_oauth_state_${p}`;
const VERIFIER_COOKIE = (p: string) => `bank_oauth_verifier_${p}`;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider: providerRaw } = await params;
  if (!VALID.includes(providerRaw as BankingProvider)) {
    return NextResponse.json({ ok: false, error: "unknown_provider" }, { status: 404 });
  }
  const provider = providerRaw as BankingProvider;

  // Auth + org gate (redirects to /login or /onboarding when absent).
  const { ctx } = await requireOrgContext();
  // Admin gate — connecting a bank is an admin act. The DB RLS on
  // bank_connections is the real boundary for any write; this is the
  // surface-level refusal so a non-admin never even starts the flow.
  if (!isAdminRole(ctx.membership.role)) {
    return NextResponse.json(
      { ok: false, error: "forbidden", message: "Only an owner or admin may connect a bank." },
      { status: 403 },
    );
  }

  const redirectUri = `${new URL(request.url).origin}/api/integrations/banking/${provider}/callback`;
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
