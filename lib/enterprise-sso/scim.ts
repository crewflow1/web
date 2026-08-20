import "server-only";

/**
 * SCIM 2.0 (RFC 7643/7644) request parsing + response shaping.
 *
 * The endpoint is a THIN provisioning seam: it maps a directory's User
 * lifecycle onto EXISTING org memberships only.
 *   - POST /Users     → link an existing membership by verified email (never
 *                       creates a user; unmatched email → 404-style deny).
 *   - PATCH /Users/id → active:false deactivates (removes) the membership.
 *   - GET /Users      → list/filter memberships as SCIM Users.
 * Groups is read-only (org = the single group); we never mutate roles via SCIM
 * in this seam.
 *
 * Everything here is pure (no DB); the route wires it to provisioning.ts.
 */

export const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_PATCH_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

export type ScimName = { formatted?: string; givenName?: string; familyName?: string };

export type ScimUser = {
  schemas: string[];
  id: string;
  userName: string;
  active: boolean;
  emails?: { value: string; primary?: boolean }[];
  name?: ScimName;
  meta: { resourceType: "User" };
};

export function scimError(status: number, detail: string, scimType?: string) {
  return {
    body: {
      schemas: [SCIM_ERROR_SCHEMA],
      detail,
      status: String(status),
      ...(scimType ? { scimType } : {}),
    },
    status,
  };
}

/** Extract the primary/first email from a SCIM User create/replace body. */
export function extractScimEmail(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const emails = b.emails;
  if (Array.isArray(emails) && emails.length > 0) {
    const primary = emails.find(
      (e) => e && typeof e === "object" && (e as Record<string, unknown>).primary === true,
    ) as Record<string, unknown> | undefined;
    const chosen = (primary ?? emails[0]) as Record<string, unknown>;
    const v = chosen?.value;
    if (typeof v === "string" && v.includes("@")) return v.trim().toLowerCase();
  }
  // Fall back to userName when it is an email (common with Azure AD / Okta).
  const userName = b.userName;
  if (typeof userName === "string" && userName.includes("@")) {
    return userName.trim().toLowerCase();
  }
  return null;
}

/**
 * Interpret a SCIM PatchOp body: does it set active=false (deactivate) or
 * active=true (reactivate)? Returns null when the patch does not touch `active`.
 * Handles the two common shapes IdPs send:
 *   { Operations: [{ op:"replace", value:{ active:false } }] }
 *   { Operations: [{ op:"replace", path:"active", value:false }] }
 */
export function readActivePatch(body: unknown): boolean | null {
  if (!body || typeof body !== "object") return null;
  const ops = (body as Record<string, unknown>).Operations;
  if (!Array.isArray(ops)) return null;
  let result: boolean | null = null;
  for (const op of ops) {
    if (!op || typeof op !== "object") continue;
    const o = op as Record<string, unknown>;
    const verb = typeof o.op === "string" ? o.op.toLowerCase() : "";
    if (verb !== "replace" && verb !== "add") continue;
    const path = typeof o.path === "string" ? o.path.toLowerCase() : null;
    if (path === "active") {
      result = coerceBool(o.value);
    } else if (o.value && typeof o.value === "object") {
      const v = o.value as Record<string, unknown>;
      if ("active" in v) result = coerceBool(v.active);
    }
  }
  return result;
}

function coerceBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v.toLowerCase() === "true") return true;
    if (v.toLowerCase() === "false") return false;
  }
  return null;
}

export type MemberForScim = {
  userId: string;
  email: string;
  fullName?: string | null;
  active: boolean;
};

export function toScimUser(m: MemberForScim): ScimUser {
  const user: ScimUser = {
    schemas: [SCIM_USER_SCHEMA],
    id: m.userId,
    userName: m.email,
    active: m.active,
    emails: [{ value: m.email, primary: true }],
    meta: { resourceType: "User" },
  };
  if (m.fullName) user.name = { formatted: m.fullName };
  return user;
}

export function scimListResponse(resources: ScimUser[]) {
  return {
    schemas: [SCIM_LIST_SCHEMA],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

/** Parse a SCIM `filter` like `userName eq "a@b.com"` → the email, else null. */
export function parseScimUserNameFilter(filter: string | null): string | null {
  if (!filter) return null;
  const m = /userName\s+eq\s+"([^"]+)"/i.exec(filter);
  if (!m) return null;
  const v = m[1]!.trim().toLowerCase();
  return v.includes("@") ? v : v;
}
