import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Regression — privilege escalation in the invite-accept flow.
 *
 * acceptOrgInvite (app/onboarding/join/actions.ts) inserts a `memberships`
 * row for the accepting user via the service-role admin client. The role MUST
 * be derived from the server-set invite metadata (user_metadata.invited_role,
 * written by the admin-gated inviteStaff / import), NEVER the hidden `role`
 * form field, which is fully client-controllable.
 *
 * The bug: the action parsed `role` from the form and inserted it directly,
 * validating only `invited_org_id`. A staff invitee could therefore POST
 * role=admin to the server action and self-promote to admin — the
 * invited_org_id check still passed. These pins fail on the pre-fix source.
 */

const ROOT = resolve(__dirname, "..", "..");
const src = readFileSync(
  resolve(ROOT, "app/onboarding/join/actions.ts"),
  "utf8",
);

describe("invite-accept role escalation is closed", () => {
  it("derives the membership role from invite metadata, not the form", () => {
    // Authoritative source: user_metadata.invited_role. Owner is never
    // grantable via invite-accept (bootstrap-only).
    expect(src).toMatch(
      /invited_role === "admin"\s*\?\s*"admin"\s*:\s*"staff"/,
    );
  });

  it("does NOT parse a trusted `role` out of the submitted form body", () => {
    // The schema must not even accept a form role, and the action must not
    // destructure one out of parsed.data.
    expect(src).not.toMatch(/role:\s*z\.enum/);
    expect(src).not.toMatch(/const\s*\{\s*org_id,\s*role,/);
    expect(src).not.toMatch(/role:\s*formData\.get/);
  });

  it("still verifies the invite is for the org being joined", () => {
    expect(src).toMatch(/invited_org_id !== org_id/);
    expect(src).toContain("invite_mismatch");
  });

  it("inserts the membership with the metadata-derived role", () => {
    expect(src).toMatch(
      /\.insert\(\{\s*org_id,\s*user_id:\s*user\.id,\s*role\s*\}\)/,
    );
  });
});
