import { describe, it, expect, vi } from "vitest";

/**
 * isStripePermissionError() lets the verify diagnostic treat a least-privilege
 * restricted key's missing read scope (e.g. Accounts read) as a SOFT pass — the
 * key authenticated but lacks that scope — while still surfacing a genuinely
 * broken key (authentication error) or a transport error as a hard failure.
 */

vi.mock("@/lib/env", () => ({ env: { STRIPE_SECRET_KEY: undefined, NEXT_PUBLIC_APP_URL: "https://crewflow.uk" } }));

import { isStripePermissionError } from "@/lib/stripe/client";

describe("isStripePermissionError", () => {
  it("true for a Stripe permission error by type", () => {
    expect(isStripePermissionError({ type: "StripePermissionError", message: "nope" })).toBe(true);
  });

  it("true for code=permission_error", () => {
    expect(isStripePermissionError({ code: "permission_error", message: "nope" })).toBe(true);
  });

  it("true for the real 'does not have the required permissions' message", () => {
    expect(
      isStripePermissionError({
        message:
          "The provided key does not have the required permissions for this endpoint. Enabling Accounts Read ('connected_account_read') would allow this request to continue.",
      }),
    ).toBe(true);
  });

  it("true for a 'permission denied' message", () => {
    expect(isStripePermissionError({ message: "Permission denied." })).toBe(true);
  });

  // An invalid/expired key must NEVER be softened — that is a real broken connection.
  it("false for an authentication error by type (bad key), even if the message mentions permission", () => {
    expect(
      isStripePermissionError({ type: "StripeAuthenticationError", message: "permission denied" }),
    ).toBe(false);
  });

  it("false for an 'Invalid API Key provided' message", () => {
    expect(isStripePermissionError({ message: "Invalid API Key provided: rk_live_***" })).toBe(false);
  });

  it("false for an 'Expired API Key' message", () => {
    expect(isStripePermissionError({ type: "StripeAuthenticationError", message: "Expired API Key provided" })).toBe(false);
  });

  it("false for a generic/transport error with no permission signal", () => {
    expect(isStripePermissionError({ type: "StripeConnectionError", message: "An error occurred with our connection to Stripe." })).toBe(false);
    expect(isStripePermissionError(new Error("socket hang up"))).toBe(false);
  });

  it("false for null / undefined / non-object input", () => {
    expect(isStripePermissionError(null)).toBe(false);
    expect(isStripePermissionError(undefined)).toBe(false);
    expect(isStripePermissionError("permission")).toBe(false);
    expect(isStripePermissionError({})).toBe(false);
  });
});
