import "server-only";
import { NextResponse } from "next/server";
import { parseBearer, resolveScimConfigByToken } from "./config";

/**
 * SCIM bearer authentication for the /scim/v2 routes. Deny-by-default:
 *   - FEATURE_ENTERPRISE_SSO off → resolveScimConfigByToken returns null → 401.
 *   - missing/malformed/unknown/disabled token → 401.
 * On success returns the org the token belongs to; every SCIM query is then
 * scoped to that org (a token can only ever act within its own tenant).
 */
export type ScimAuthOk = { ok: true; orgId: string; configId: string };
export type ScimAuthErr = { ok: false; response: NextResponse };

const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

export async function authenticateScim(
  request: Request,
): Promise<ScimAuthOk | ScimAuthErr> {
  const token = parseBearer(request.headers.get("authorization"));
  const cfg = await resolveScimConfigByToken(token);
  if (!cfg) {
    return {
      ok: false,
      response: NextResponse.json(
        { schemas: [SCIM_ERROR_SCHEMA], detail: "Unauthorized", status: "401" },
        { status: 401, headers: { "www-authenticate": "Bearer" } },
      ),
    };
  }
  return { ok: true, orgId: cfg.orgId, configId: cfg.configId };
}
