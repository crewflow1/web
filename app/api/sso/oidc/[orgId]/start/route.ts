import { NextResponse, type NextRequest } from "next/server";
import { loadLiveSsoConfig } from "@/lib/enterprise-sso/config";
import { fetchDiscovery } from "@/lib/enterprise-sso/oidc";
import { generatePkce, randomToken } from "@/lib/enterprise-sso/pkce";
import { oidcRedirectUri } from "@/lib/enterprise-sso/urls";
import { recordSsoAudit } from "@/lib/enterprise-sso/provisioning";

/**
 * GET /api/sso/oidc/[orgId]/start — begin the OIDC authorization-code + PKCE
 * flow. DARK: 404 unless flag on AND an enabled OIDC config exists.
 *
 * Mints state + nonce + a PKCE verifier, stores them in httpOnly, SameSite=Lax,
 * short-TTL cookies, and redirects to the IdP authorization endpoint. The
 * callback re-reads the cookies to bind the response (CSRF via state, replay via
 * nonce, code-interception via PKCE).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };
const TEN_MIN = 60 * 10;

export async function GET(request: NextRequest, { params }: Ctx) {
  const { orgId } = await params;
  const cfg = await loadLiveSsoConfig(orgId, "oidc");
  if (!cfg || !cfg.oidcIssuer || !cfg.oidcClientId) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const origin = new URL(request.url).origin;

  let disco;
  try {
    disco = await fetchDiscovery(cfg.oidcIssuer, cfg.oidcDiscoveryUrl);
  } catch {
    await recordSsoAudit({ orgId, protocol: "oidc", event: "discovery_failed", outcome: "deny" });
    return NextResponse.json({ error: "idp_unavailable" }, { status: 502 });
  }

  const state = randomToken(24);
  const nonce = randomToken(24);
  const pkce = generatePkce();

  const authUrl = new URL(disco.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", cfg.oidcClientId);
  authUrl.searchParams.set("redirect_uri", oidcRedirectUri(origin, orgId));
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("code_challenge", pkce.challenge);
  authUrl.searchParams.set("code_challenge_method", pkce.method);

  const res = NextResponse.redirect(authUrl.toString(), { status: 302 });
  const cookieOpts = {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: `/api/sso/oidc/${orgId}`,
    maxAge: TEN_MIN,
  };
  res.cookies.set(`cf_oidc_state_${orgId}`, state, cookieOpts);
  res.cookies.set(`cf_oidc_nonce_${orgId}`, nonce, cookieOpts);
  res.cookies.set(`cf_oidc_verifier_${orgId}`, pkce.verifier, cookieOpts);
  return res;
}
