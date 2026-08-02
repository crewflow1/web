import { NextResponse, type NextRequest } from "next/server";

import { requireOrgContext } from "@/server/auth/session";
import { buildAuthorizeUrl, isHmrcFlow, type HmrcFlow } from "@/lib/integrations/hmrc/oauth";

/**
 * HMRC MTD OAuth — CONNECT initiation. DARK.
 *
 * Starts the "connect your HMRC account" flow for an MTD family (`[flow]` =
 * vat | cis): gate the caller (authenticated + org + admin), then ask the OAuth
 * resolver for an authorize URL. When HMRC is not connectable — ALWAYS, today,
 * because no client credentials are set and NEXT_PUBLIC_FEATURE_HMRC_CONNECT is
 * off (two-switch) — `buildAuthorizeUrl` REFUSES and this route returns a clean
 * 503 `not_configured` JSON state WITHOUT redirecting anywhere and WITHOUT
 * issuing PKCE material.
 *
 * LEGAL BOUNDARY: connecting is not filing. Even live, this only obtains OAuth
 * tokens; the substrate never submits (HMRC vendor recognition is a separate
 * legal gate). See lib/integrations/hmrc/oauth.ts.
 *
 * When live, it sets the PKCE `code_verifier` + anti-CSRF `state` as httpOnly
 * cookies (verified by the callback) and 302s the tenant to HMRC. No secret is
 * ever logged.
 */

function isAdminRole(role: string): boolean {
  return role === "owner" || role === "admin";
}

const STATE_COOKIE = (f: string) => `hmrc_oauth_state_${f}`;
const VERIFIER_COOKIE = (f: string) => `hmrc_oauth_verifier_${f}`;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ flow: string }> },
) {
  const { flow: flowRaw } = await params;
  if (!isHmrcFlow(flowRaw)) {
    return NextResponse.json({ ok: false, error: "unknown_flow" }, { status: 404 });
  }
  const flow: HmrcFlow = flowRaw;

  // Auth + org gate (redirects to /login or /onboarding when absent).
  const { ctx } = await requireOrgContext();
  // Admin gate — connecting HMRC is an admin act. The DB RLS on hmrc_connections
  // is the real boundary for any write; this is the surface-level refusal.
  if (!isAdminRole(ctx.membership.role)) {
    return NextResponse.json(
      { ok: false, error: "forbidden", message: "Only an owner or admin may connect HMRC." },
      { status: 403 },
    );
  }

  const redirectUri = `${new URL(request.url).origin}/api/integrations/hmrc/${flow}/callback`;
  const authorize = buildAuthorizeUrl(flow, redirectUri);

  // DARK: not configured → 503, no redirect, no cookies.
  if (!authorize.ok) {
    return NextResponse.json(
      { ok: false, flow, status: "not_configured", message: authorize.message },
      { status: 503 },
    );
  }

  // LIVE (unreachable dark): persist PKCE + state, redirect to HMRC.
  const res = NextResponse.redirect(authorize.challenge.url);
  const cookieOpts = {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 600, // 10 minutes — the authorize round-trip window.
  };
  res.cookies.set(STATE_COOKIE(flow), authorize.challenge.state, cookieOpts);
  res.cookies.set(VERIFIER_COOKIE(flow), authorize.challenge.codeVerifier, cookieOpts);
  return res;
}
