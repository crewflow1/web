import { NextResponse, type NextRequest } from "next/server";
import { loadLiveSsoConfig } from "@/lib/enterprise-sso/config";
import {
  decodeSamlResponse,
  validateSamlResponse,
} from "@/lib/enterprise-sso/saml";
import {
  findActiveMembershipByEmail,
  consumeSamlAssertion,
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
 *   3. REPLAY guard (F1): atomically CONSUME the assertion by its ID; a
 *      previously-seen assertion (or one with no ID) → 403. This closes the
 *      capture-and-re-POST window a captured-but-still-in-conditions assertion
 *      would otherwise have.
 *   4. Map the verified email to an EXISTING membership. Unmatched → 403
 *      (NEVER auto-create).
 *   5. On a match, record an allow and hand off to session establishment.
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

  // NOTE (F1): RelayState is ATTACKER-CONTROLLED and is NOT an InResponseTo — we
  // deliberately do NOT pass it as expectedInResponseTo (doing so was a
  // false assurance). InResponseTo can only be anchored to a server-issued
  // request id, which arrives with the SP-initiated start route at activation;
  // until then replay is closed by the consumed-assertion cache + conditions.
  const result = validateSamlResponse(xml, {
    idpEntityId: cfg.samlIdpEntityId,
    idpX509Cert: cfg.samlIdpX509Cert,
    spEntityId: cfg.spEntityId ?? deriveSpEntityId(origin, orgId),
    acsUrl: deriveAcsUrl(origin, orgId),
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

  // ── REPLAY guard (F1) ──
  // An assertion with no ID cannot be replay-protected → reject.
  if (!result.assertionId) {
    await recordSsoAudit({
      orgId,
      protocol: "saml",
      event: "assertion_no_id",
      outcome: "deny",
      subject: result.email,
    });
    return NextResponse.json({ error: "assertion_missing_id" }, { status: 403 });
  }
  // Atomically consume it. Fail CLOSED on a DB error we can't interpret, and
  // reject an already-consumed assertion as a replay.
  const consume = await consumeSamlAssertion({
    orgId,
    assertionId: result.assertionId,
    notOnOrAfterMs: result.notOnOrAfterMs,
  });
  if (consume.errored) {
    await recordSsoAudit({
      orgId,
      protocol: "saml",
      event: "replay_check_error",
      outcome: "deny",
      subject: result.email,
    });
    return NextResponse.json({ error: "assertion_rejected" }, { status: 403 });
  }
  if (!consume.consumed) {
    await recordSsoAudit({
      orgId,
      protocol: "saml",
      event: "assertion_replayed",
      outcome: "deny",
      subject: result.email,
      detail: { assertion_id: result.assertionId },
    });
    return NextResponse.json({ error: "assertion_replayed" }, { status: 403 });
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
