import { NextResponse } from "next/server";
import { authenticateScim } from "@/lib/enterprise-sso/scim-auth";
import { SCIM_GROUP_SCHEMA, SCIM_LIST_SCHEMA } from "@/lib/enterprise-sso/scim";
import { listOrgMembersForScim } from "@/lib/enterprise-sso/scim-store";

/**
 * /scim/v2/Groups — SCIM 2.0 Group collection (bearer-authenticated per org).
 *
 * READ-ONLY. This seam models a single group: the org itself, with its members.
 * SCIM never mutates group membership or roles here (map-to-existing only);
 * User deprovision is the sole write path (see /scim/v2/Users). Group writes
 * would be a role-management surface, deliberately out of this dark seam.
 *
 * Deny-by-default: no valid enabled token → 401.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await authenticateScim(request);
  if (!auth.ok) return auth.response;

  const members = await listOrgMembersForScim(auth.orgId);
  const group = {
    schemas: [SCIM_GROUP_SCHEMA],
    id: auth.orgId,
    displayName: "Organization Members",
    members: members.map((m) => ({ value: m.userId, display: m.email })),
    meta: { resourceType: "Group" },
  };
  return NextResponse.json({
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: 1,
    startIndex: 1,
    itemsPerPage: 1,
    Resources: [group],
  });
}
