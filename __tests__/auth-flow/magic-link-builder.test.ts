import { describe, expect, it } from "vitest";
import { buildCallbackMagicLink } from "@/lib/auth/magic-link";

/**
 * Unit coverage for the magic-link URL builder — the fix for the action_link
 * vs token_hash trap (see lib/auth/magic-link.ts). The regression it guards:
 * embedding GoTrue's hosted action_link lands the session in a URL hash
 * fragment the server /auth/callback can't read, so the one-time token is
 * burned and the invitee/customer is bounced to /login.
 */

const APP = "https://crewflow.uk";
const HASHED = "abc123def456";

describe("buildCallbackMagicLink", () => {
  it("builds a /auth/callback URL carrying token_hash + type", () => {
    const url = buildCallbackMagicLink({
      appUrl: APP,
      properties: { hashed_token: HASHED },
      type: "magiclink",
    });
    expect(url).toBe(
      `${APP}/auth/callback?token_hash=${HASHED}&type=magiclink`,
    );
  });

  it("defaults the type to magiclink", () => {
    const url = buildCallbackMagicLink({ appUrl: APP, properties: { hashed_token: HASHED } });
    expect(url).toContain("type=magiclink");
  });

  it("supports other OTP types (recovery / invite / email)", () => {
    expect(
      buildCallbackMagicLink({ appUrl: APP, properties: { hashed_token: HASHED }, type: "recovery" }),
    ).toContain("type=recovery");
  });

  it("strips a trailing slash on appUrl so the path is not doubled", () => {
    const url = buildCallbackMagicLink({
      appUrl: "https://crewflow.uk/",
      properties: { hashed_token: HASHED },
    });
    expect(url).toBe(`https://crewflow.uk/auth/callback?token_hash=${HASHED}&type=magiclink`);
  });

  it("returns null when no hashed_token is present (callers fall back to /login copy)", () => {
    expect(buildCallbackMagicLink({ appUrl: APP, properties: {} })).toBeNull();
    expect(buildCallbackMagicLink({ appUrl: APP, properties: null })).toBeNull();
    expect(
      buildCallbackMagicLink({ appUrl: APP, properties: { hashed_token: null } }),
    ).toBeNull();
  });

  it("NEVER derives the link from the hosted action_link", () => {
    const url = buildCallbackMagicLink({
      appUrl: APP,
      properties: {
        hashed_token: HASHED,
        action_link:
          "http://127.0.0.1:54321/auth/v1/verify?token=raw&type=magiclink&redirect_to=x",
      },
    });
    expect(url).not.toContain("/auth/v1/verify");
    expect(url).not.toContain("token=raw");
  });

  it("carries a safe local `next` path but drops absolute/protocol-relative ones", () => {
    expect(
      buildCallbackMagicLink({
        appUrl: APP,
        properties: { hashed_token: HASHED },
        next: "/update-password",
      }),
    ).toContain("next=%2Fupdate-password");

    // Open-redirect guards: absolute + protocol-relative must be dropped.
    for (const bad of ["https://evil.test/x", "//evil.test/x"]) {
      const url = buildCallbackMagicLink({
        appUrl: APP,
        properties: { hashed_token: HASHED },
        next: bad,
      });
      expect(url).not.toContain("next=");
    }
  });
});
