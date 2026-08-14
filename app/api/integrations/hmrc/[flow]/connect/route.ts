import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
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
const VRN_COOKIE = (f: string) => `hmrc_oauth_vrn_${f}`;

/** Trim the org's VAT number to a non-empty handle, or null when truly absent. */
function normaliseVat(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

/** Redirect back to the integrations settings page carrying an `hmrc` status code. */
function backToSettings(origin: string, status: string): NextResponse {
  const u = new URL(`${origin}/settings/integrations`);
  u.searchParams.set("hmrc", status);
  return NextResponse.redirect(u);
}

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

  const { origin } = new URL(request.url);
  const redirectUri = `${origin}/api/integrations/hmrc/${flow}/callback`;
  const authorize = buildAuthorizeUrl(flow, redirectUri);

  // DARK: not configured → 503, no redirect, no cookies.
  if (!authorize.ok) {
    return NextResponse.json(
      { ok: false, flow, status: "not_configured", message: authorize.message },
      { status: 503 },
    );
  }

  // PRECONDITION: the connection needs the org's VAT registration number. HMRC's
  // OAuth callback returns only `code`+`state` (never a VRN), and the DB CHECK
  // forbids a `connected` row without `hmrc_vrn`. So we resolve the VRN here from
  // `organizations.vat_number` (org-pinned, collected at onboarding) and stash it
  // for the callback. If the org has no VAT number we REFUSE up front with a clear
  // precondition code — rather than dead-ending the tenant AFTER a token exchange.
  const supabase = await createClient();
  const { data: orgRow, error: orgErr } = await supabase
    .from("organizations")
    .select("vat_number" as never)
    .eq("id", ctx.org.id)
    .maybeSingle();
  if (orgErr) {
    return backToSettings(origin, "error");
  }
  const vatNumber = normaliseVat((orgRow as { vat_number?: unknown } | null)?.vat_number);
  if (!vatNumber) {
    return backToSettings(origin, "no_vat_number");
  }

  // LIVE (unreachable dark): persist PKCE + state + the resolved VRN, redirect to
  // HMRC. The VRN cookie is httpOnly (matching the verifier), so the callback
  // reads it server-side and the browser cannot read/forge it from script.
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
  res.cookies.set(VRN_COOKIE(flow), vatNumber, cookieOpts);
  return res;
}
