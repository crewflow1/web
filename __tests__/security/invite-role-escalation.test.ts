import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Regression — privilege escalation in the invite-accept flow.
 *
 * acceptOrgInvite (app/onboarding/join/actions.ts) inserts a `memberships`
 * row for the accepting user via the service-role admin client. The org and
 * role it grants MUST come from the invite anchor set by the admin-gated
 * invite flow — and that anchor lives in `app_metadata`, the service-role-only
 * metadata bucket.
 *
 * TWO escalation vectors, both closed and pinned here:
 *   1. The hidden `role` FORM field — client-controllable; must never be parsed.
 *   2. `user_metadata` — ALSO user-controllable (supabase.auth.updateUser({data})
 *      writes raw_user_meta_data). Anchoring invited_org_id/invited_role there
 *      let a self-signed-up attacker set their own metadata to a victim org +
 *      admin and join cross-tenant as admin. Only `app_metadata` is out of the
 *      user's reach, so it is the sole authority. These pins fail on the
 *      pre-fix source (which read user_metadata).
 */

const ROOT = resolve(__dirname, "..", "..");
const actionsSrc = readFileSync(
  resolve(ROOT, "app/onboarding/join/actions.ts"),
  "utf8",
);
const inviteSrc = readFileSync(
  resolve(ROOT, "server/services/staff-invite.ts"),
  "utf8",
);
const pageSrc = readFileSync(
  resolve(ROOT, "app/onboarding/join/page.tsx"),
  "utf8",
);
const invitesListSrc = readFileSync(
  resolve(ROOT, "app/(app)/staff/_invites.ts"),
  "utf8",
);

describe("invite-accept role escalation is closed", () => {
  it("derives org + role from app_metadata (admin-only), not user_metadata", () => {
    // The authorization read must be app_metadata. It must NOT read the
    // user-writable user_metadata for the org/role decision.
    expect(actionsSrc).toMatch(/app_metadata\s*\?\?\s*\{\}/);
    expect(actionsSrc).toMatch(
      /invited_role === "admin"\s*\?\s*"admin"\s*:\s*"staff"/,
    );
    // The org check + role derivation must be sourced from the app_metadata
    // object (`authz`), never a `user_metadata`-derived one.
    const authzBlock = actionsSrc.slice(
      actionsSrc.indexOf("app_metadata"),
      actionsSrc.indexOf("const admin ="),
    );
    // The authz READ must not come from user_metadata (comment mentions are fine).
    expect(authzBlock).not.toMatch(/user_metadata\s*\?\?/);
  });

  it("does NOT parse a trusted `role` out of the submitted form body", () => {
    expect(actionsSrc).not.toMatch(/role:\s*z\.enum/);
    expect(actionsSrc).not.toMatch(/const\s*\{\s*org_id,\s*role,/);
    expect(actionsSrc).not.toMatch(/role:\s*formData\.get/);
  });

  it("still verifies the invite is for the org being joined", () => {
    expect(actionsSrc).toMatch(/invited_org_id !== org_id/);
    expect(actionsSrc).toContain("invite_mismatch");
  });

  it("inserts the membership with the app_metadata-derived role", () => {
    expect(actionsSrc).toMatch(
      /\.insert\(\{\s*org_id,\s*user_id:\s*user\.id,\s*role\s*\}\)/,
    );
  });

  it("sendStaffInvite writes the invite anchor to app_metadata, never user_metadata", () => {
    // createUser + updateUserById must set app_metadata; they must NOT put the
    // invited_* payload into user_metadata (where the invitee could rewrite it).
    expect(inviteSrc).toMatch(/app_metadata:\s*appMetadata/);
    expect(inviteSrc).not.toMatch(/user_metadata:\s*args\.metadata/);
    expect(inviteSrc).not.toMatch(/user_metadata:\s*userMetadata/);
  });

  it("all invite-anchor readers read app_metadata (no user_metadata authz reads left)", () => {
    // join page + pending-invites list read the org/role from app_metadata.
    // Negative checks target the READ expression (`user_metadata ?? {}`), not
    // the bare word, so an explanatory comment mentioning user_metadata is fine.
    expect(pageSrc).toMatch(/app_metadata\s*\?\?\s*\{\}/);
    expect(pageSrc).not.toMatch(/user_metadata\s*\?\?\s*\{\}/);
    expect(invitesListSrc).toMatch(/app_metadata\s*\?\?\s*\{\}/);
    const scopeBlock = invitesListSrc.slice(
      invitesListSrc.indexOf("for (const u of"),
      invitesListSrc.indexOf("invites.push"),
    );
    expect(scopeBlock).not.toMatch(/user_metadata\s*\?\?/);
  });
});
