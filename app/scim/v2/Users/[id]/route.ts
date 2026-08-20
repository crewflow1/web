import { NextResponse } from "next/server";
import { authenticateScim } from "@/lib/enterprise-sso/scim-auth";
import { readActivePatch, scimError, toScimUser } from "@/lib/enterprise-sso/scim";
import { getOrgMemberForScim } from "@/lib/enterprise-sso/scim-store";
import { deactivateMembership, recordSsoAudit } from "@/lib/enterprise-sso/provisioning";

/**
 * /scim/v2/Users/[id] — single SCIM User (id = the org member's user_id).
 *
 * GET    — return the member as a SCIM User (404 if not a member).
 * PATCH  — active:false DEACTIVATES (removes) the membership. active:true is a
 *          no-op when already a member; this seam NEVER grants NEW org access
 *          via SCIM (a removed member cannot be reactivated through SCIM).
 * DELETE — deprovision = remove the membership (204). Membership-scoped only:
 *          the user account and other-org memberships are untouched.
 *
 * Deny-by-default: no valid enabled token → 401.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  const auth = await authenticateScim(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const member = await getOrgMemberForScim(auth.orgId, id);
  if (!member) {
    const e = scimError(404, "User not found", "noTarget");
    return NextResponse.json(e.body, { status: e.status });
  }
  return NextResponse.json(toScimUser(member));
}

export async function PATCH(request: Request, { params }: Ctx) {
  const auth = await authenticateScim(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const member = await getOrgMemberForScim(auth.orgId, id);
  if (!member) {
    const e = scimError(404, "User not found", "noTarget");
    return NextResponse.json(e.body, { status: e.status });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    const e = scimError(400, "Malformed PatchOp", "invalidSyntax");
    return NextResponse.json(e.body, { status: e.status });
  }

  const active = readActivePatch(body);
  if (active === false) {
    const { removed } = await deactivateMembership(auth.orgId, member.email);
    await recordSsoAudit({
      orgId: auth.orgId,
      protocol: "scim",
      event: "deactivate",
      outcome: "allow",
      subject: member.email,
      detail: { removed },
    });
    return NextResponse.json(toScimUser({ ...member, active: false }));
  }

  // active:true or a patch that does not deactivate → return current state.
  // We never grant NEW access via SCIM (map-to-existing only).
  return NextResponse.json(toScimUser(member));
}

export async function DELETE(request: Request, { params }: Ctx) {
  const auth = await authenticateScim(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const member = await getOrgMemberForScim(auth.orgId, id);
  if (!member) {
    const e = scimError(404, "User not found", "noTarget");
    return NextResponse.json(e.body, { status: e.status });
  }
  const { removed } = await deactivateMembership(auth.orgId, member.email);
  await recordSsoAudit({
    orgId: auth.orgId,
    protocol: "scim",
    event: "delete",
    outcome: "allow",
    subject: member.email,
    detail: { removed },
  });
  return new NextResponse(null, { status: 204 });
}
