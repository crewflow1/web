import { NextResponse } from "next/server";
import { authenticateScim } from "@/lib/enterprise-sso/scim-auth";
import { SCIM_GROUP_SCHEMA, scimError } from "@/lib/enterprise-sso/scim";
import { listOrgMembersForScim } from "@/lib/enterprise-sso/scim-store";

/**
 * /scim/v2/Groups/[id] — the org group (READ-ONLY). The only valid id is the
 * caller's own org id (a token can never read another tenant's group).
 * Deny-by-default: no valid enabled token → 401.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Ctx) {
  const auth = await authenticateScim(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  if (id !== auth.orgId) {
    const e = scimError(404, "Group not found", "noTarget");
    return NextResponse.json(e.body, { status: e.status });
  }

  const members = await listOrgMembersForScim(auth.orgId);
  return NextResponse.json({
    schemas: [SCIM_GROUP_SCHEMA],
    id: auth.orgId,
    displayName: "Organization Members",
    members: members.map((m) => ({ value: m.userId, display: m.email })),
    meta: { resourceType: "Group" },
  });
}
