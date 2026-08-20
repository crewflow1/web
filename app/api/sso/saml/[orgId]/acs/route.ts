import { NextResponse, type NextRequest } from "next/server";
import { loadLiveSsoConfig } from "@/lib/enterprise-sso/config";
import {
  decodeSamlResponse,
  validateSamlResponse,
} from "@/lib/enterprise-sso/saml";
import {
  findActiveMembershipByEmail,
  recordSsoAudit,
} from "@/lib/enterprise-sso/provisioning";
import { spEntityId as deriveSpEntityId, acsUrl as deriveAcsUrl } from "@/lib/enterprise-sso/urls";

/**
 * POST /api/sso/saml/[orgId]/acs — the SAML Assertion Consumer Service.
 *
 * DARK + deny-by-default. Flow:
 *   1. loadLiveSsoConfig(orgId,'saml') — 404 when flag off / no enabled config.
 *   2. Validate the SAMLResponse: signature (against the CONFIGURED cert),
 *      conditions (issuer/audience/times/recipient), NameID/email. Invalid → 403.
 *   3. Map the verified email to an EXISTING membership. Unmatched → 403
 *      (NEVER auto-create).
 *   4. On a match, record an allow and hand off to session establishment.
 *
 * SESSION ESTABLISHMENT is the final activation wiring: a live deploy mints the
 * Supabase session for the matched user here. This dark seam stops at the
 * verified+matched boundary (it never fabricates a session), returning 200 with
 * the matched subject so the boundary is provable end-to-end in tests.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  const { orgId } = await params;

  const cfg = await loadLiveSsoConfig(orgId, "saml");
  if (!cfg || !cfg.samlIdpEntityId || !cfg.samlIdpX509Cert) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const origin = new URL(request.url).origin;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    await recordSsoAudit({
      orgId,
      protocol: "saml",
      event: "bad_request",
      outcome: "deny",
    });
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const samlResponse = form.get("SAMLResponse");
  if (typeof samlResponse !== "string") {
    await recordSsoAudit({ orgId, protocol: "saml", event: "no_saml_response", outcome: "deny" });
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const xml = decodeSamlResponse(samlResponse);
  if (!xml) {
    await recordSsoAudit({ orgId, protocol: "saml", event: "undecodable", outcome: "deny" });
    return NextResponse.json({ error: "invalid_saml" }, { status: 400 });
  }

  const relayState = form.get("RelayState");
  const expectedInResponseTo =
    typeof relayState === "string" && relayState.length > 0 ? relayState : null;

  const result = validateSamlResponse(xml, {
    idpEntityId: cfg.samlIdpEntityId,
    idpX509Cert: cfg.samlIdpX509Cert,
    spEntityId: cfg.spEntityId ?? deriveSpEntityId(origin, orgId),
    acsUrl: deriveAcsUrl(origin, orgId),
    expectedInResponseTo,
  });

  if (!result.ok) {
    await recordSsoAudit({
      orgId,
      protocol: "saml",
      event: "assertion_rejected",
      outcome: "deny",
      detail: { reason: result.reason },
    });
    return NextResponse.json({ error: "assertion_rejected" }, { status: 403 });
  }

  const member = await findActiveMembershipByEmail(orgId, result.email);
  if (!member) {
    await recordSsoAudit({
      orgId,
      protocol: "saml",
      event: "denied_unmatched",
      outcome: "deny",
      subject: result.email,
    });
    return NextResponse.json({ error: "no_matching_member" }, { status: 403 });
  }

  await recordSsoAudit({
    orgId,
    protocol: "saml",
    event: "assertion_accepted",
    outcome: "allow",
    subject: result.email,
    detail: { membership_id: member.membershipId },
  });

  // Boundary reached: validated assertion → matched membership. Live activation
  // mints the session here.
  return NextResponse.json({
    status: "authenticated",
    org_id: orgId,
    user_id: member.userId,
    email: member.email,
  });
}
