import { NextResponse, type NextRequest } from "next/server";
import { loadLiveSsoConfig } from "@/lib/enterprise-sso/config";
import { spEntityId as deriveSpEntityId, acsUrl as deriveAcsUrl } from "@/lib/enterprise-sso/urls";

/**
 * GET /api/sso/saml/[orgId]/metadata — SP metadata for the org's SAML config.
 *
 * DARK: 404 unless FEATURE_ENTERPRISE_SSO is on AND the org has an ENABLED SAML
 * config (loadLiveSsoConfig). The document a customer's IdP admin consumes to
 * register CrewFlow as an SP: our EntityID + ACS URL.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ orgId: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const { orgId } = await params;
  const cfg = await loadLiveSsoConfig(orgId, "saml");
  if (!cfg) {
    // The surface does not exist yet.
    return new NextResponse("Not Found", { status: 404 });
  }

  const origin = new URL(request.url).origin;
  const entityId = cfg.spEntityId ?? deriveSpEntityId(origin, orgId);
  const acs = deriveAcsUrl(origin, orgId);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${escapeXml(entityId)}">
  <SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${escapeXml(acs)}" index="0" isDefault="true"/>
  </SPSSODescriptor>
</EntityDescriptor>`;

  return new NextResponse(xml, {
    status: 200,
    headers: { "content-type": "application/samlmetadata+xml; charset=utf-8" },
  });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
