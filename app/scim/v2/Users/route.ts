import { NextResponse } from "next/server";
import { authenticateScim } from "@/lib/enterprise-sso/scim-auth";
import {
  extractScimEmail,
  parseScimUserNameFilter,
  scimError,
  scimListResponse,
  toScimUser,
} from "@/lib/enterprise-sso/scim";
import { listOrgMembersForScim } from "@/lib/enterprise-sso/scim-store";
import { findActiveMembershipByEmail, recordSsoAudit } from "@/lib/enterprise-sso/provisioning";

/**
 * /scim/v2/Users — SCIM 2.0 User collection (bearer-authenticated per org).
 *
 * GET  — list org members as SCIM Users (optional `filter=userName eq "…"`).
 * POST — LINK an existing membership by verified email. NEVER creates a user:
 *        an unmatched email is DENIED (404) — auto-provisioning is disabled.
 *
 * Deny-by-default: no valid enabled token → 401 (authenticateScim).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await authenticateScim(request);
  if (!auth.ok) return auth.response;

  const filter = new URL(request.url).searchParams.get("filter");
  const emailFilter = parseScimUserNameFilter(filter);
  const members = await listOrgMembersForScim(auth.orgId, emailFilter);
  return NextResponse.json(scimListResponse(members.map(toScimUser)));
}

export async function POST(request: Request) {
  const auth = await authenticateScim(request);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    const e = scimError(400, "Malformed request body", "invalidSyntax");
    return NextResponse.json(e.body, { status: e.status });
  }

  const email = extractScimEmail(body);
  if (!email) {
    const e = scimError(400, "A primary email or userName email is required", "invalidValue");
    return NextResponse.json(e.body, { status: e.status });
  }

  // MAP-TO-EXISTING only. No user is ever created.
  const member = await findActiveMembershipByEmail(auth.orgId, email);
  if (!member) {
    await recordSsoAudit({
      orgId: auth.orgId,
      protocol: "scim",
      event: "provision_denied_unmatched",
      outcome: "deny",
      subject: email,
    });
    const e = scimError(
      404,
      "No existing member matches this email; auto-provisioning of new users is disabled",
      "noTarget",
    );
    return NextResponse.json(e.body, { status: e.status });
  }

  await recordSsoAudit({
    orgId: auth.orgId,
    protocol: "scim",
    event: "provision_linked",
    outcome: "allow",
    subject: email,
    detail: { membership_id: member.membershipId },
  });

  const scimUser = toScimUser({
    userId: member.userId,
    email: member.email,
    active: true,
  });
  return NextResponse.json(scimUser, { status: 200 });
}
