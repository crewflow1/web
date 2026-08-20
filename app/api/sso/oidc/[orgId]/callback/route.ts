import { NextResponse, type NextRequest } from "next/server";
import {
  loadLiveSsoConfig,
  decryptOidcClientSecret,
} from "@/lib/enterprise-sso/config";
import { fetchDiscovery, fetchJwks, verifyIdToken } from "@/lib/enterprise-sso/oidc";
import { oidcRedirectUri } from "@/lib/enterprise-sso/urls";
import {
  findActiveMembershipByEmail,
  recordSsoAudit,
} from "@/lib/enterprise-sso/provisioning";

/**
 * GET /api/sso/oidc/[orgId]/callback — the OIDC redirect endpoint.
 *
 * DARK + deny-by-default. Flow:
 *   1. loadLiveSsoConfig(orgId,'oidc') — 404 when flag off / no enabled config.
 *   2. Bind to the start request: state cookie must match the state param
 *      (CSRF); the PKCE verifier + nonce are read from cookies.
 *   3. Exchange the code at the token endpoint (PKCE + client secret).
 *   4. verifyIdToken: signature (JWKS), iss/aud/exp, nonce echo. Invalid → 403.
 *   5. Map the verified email to an EXISTING membership. Unmatched → 403
 *      (NEVER auto-create).
 *
 * Like the SAML ACS, this dark seam stops at the verified+matched boundary and
 * returns 200 with the subject; live activation mints the session here.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const { orgId } = await params;
  const cfg = await loadLiveSsoConfig(orgId, "oidc");
  if (!cfg || !cfg.oidcIssuer || !cfg.oidcClientId) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const url = new URL(request.url);
  const origin = url.origin;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const stateCookie = request.cookies.get(`cf_oidc_state_${orgId}`)?.value ?? null;
  const nonceCookie = request.cookies.get(`cf_oidc_nonce_${orgId}`)?.value ?? null;
  const verifier = request.cookies.get(`cf_oidc_verifier_${orgId}`)?.value ?? null;

  if (!code || !state || !stateCookie || state !== stateCookie || !verifier || !nonceCookie) {
    await recordSsoAudit({ orgId, protocol: "oidc", event: "state_mismatch", outcome: "deny" });
    return NextResponse.json({ error: "invalid_state" }, { status: 403 });
  }

  let disco;
  try {
    disco = await fetchDiscovery(cfg.oidcIssuer, cfg.oidcDiscoveryUrl);
  } catch {
    await recordSsoAudit({ orgId, protocol: "oidc", event: "discovery_failed", outcome: "deny" });
    return NextResponse.json({ error: "idp_unavailable" }, { status: 502 });
  }

  // Exchange the authorization code for tokens (PKCE + confidential client).
  let idToken: string | null = null;
  try {
    const clientSecret = decryptOidcClientSecret(cfg);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: oidcRedirectUri(origin, orgId),
      client_id: cfg.oidcClientId,
      client_secret: clientSecret,
      code_verifier: verifier,
    });
    const tokenRes = await fetch(disco.token_endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    });
    if (!tokenRes.ok) throw new Error(`token endpoint ${tokenRes.status}`);
    const tokens = (await tokenRes.json()) as { id_token?: string };
    idToken = tokens.id_token ?? null;
  } catch {
    await recordSsoAudit({ orgId, protocol: "oidc", event: "code_exchange_failed", outcome: "deny" });
    return NextResponse.json({ error: "token_exchange_failed" }, { status: 502 });
  }

  if (!idToken) {
    await recordSsoAudit({ orgId, protocol: "oidc", event: "no_id_token", outcome: "deny" });
    return NextResponse.json({ error: "no_id_token" }, { status: 403 });
  }

  let jwks;
  try {
    jwks = await fetchJwks(disco.jwks_uri);
  } catch {
    await recordSsoAudit({ orgId, protocol: "oidc", event: "jwks_failed", outcome: "deny" });
    return NextResponse.json({ error: "idp_unavailable" }, { status: 502 });
  }

  const result = verifyIdToken(idToken, {
    issuer: cfg.oidcIssuer,
    clientId: cfg.oidcClientId,
    expectedNonce: nonceCookie,
    jwks,
  });

  const clearCookies = (res: NextResponse) => {
    const opts = { path: `/api/sso/oidc/${orgId}`, maxAge: 0 };
    res.cookies.set(`cf_oidc_state_${orgId}`, "", opts);
    res.cookies.set(`cf_oidc_nonce_${orgId}`, "", opts);
    res.cookies.set(`cf_oidc_verifier_${orgId}`, "", opts);
    return res;
  };

  if (!result.ok) {
    await recordSsoAudit({
      orgId,
      protocol: "oidc",
      event: "id_token_rejected",
      outcome: "deny",
      detail: { reason: result.reason },
    });
    return clearCookies(NextResponse.json({ error: "id_token_rejected" }, { status: 403 }));
  }

  const member = await findActiveMembershipByEmail(orgId, result.email);
  if (!member) {
    await recordSsoAudit({
      orgId,
      protocol: "oidc",
      event: "denied_unmatched",
      outcome: "deny",
      subject: result.email,
    });
    return clearCookies(NextResponse.json({ error: "no_matching_member" }, { status: 403 }));
  }

  await recordSsoAudit({
    orgId,
    protocol: "oidc",
    event: "id_token_accepted",
    outcome: "allow",
    subject: result.email,
    detail: { membership_id: member.membershipId },
  });

  return clearCookies(
    NextResponse.json({
      status: "authenticated",
      org_id: orgId,
      user_id: member.userId,
      email: member.email,
    }),
  );
}
