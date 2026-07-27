import { describe, it, expect } from "vitest";
import {
  CONSENT_COOKIE,
  CONSENT_MAX_AGE_SEC,
  analyticsAllowed,
  analyticsConfigured,
  isFirstPartySurface,
  parseConsent,
  readConsentFromCookieString,
  serializeConsentCookie,
  shouldShowBanner,
} from "@/lib/analytics/consent";

/**
 * Cookie-consent decision logic.
 *
 * The two guarantees this launch depends on:
 *   1. analyticsAllowed() is true ONLY when analytics are configured AND the
 *      user explicitly granted consent — never on "no key", "no choice", or
 *      "denied". This is what enforces "no analytics before consent".
 *   2. The banner + analytics never touch the customer portal / public quote
 *      pages (isFirstPartySurface).
 */

describe("parseConsent", () => {
  it("accepts the two known states and rejects everything else", () => {
    expect(parseConsent("granted")).toBe("granted");
    expect(parseConsent("denied")).toBe("denied");
    expect(parseConsent("yes")).toBeNull();
    expect(parseConsent("")).toBeNull();
    expect(parseConsent(undefined)).toBeNull();
    expect(parseConsent(null)).toBeNull();
  });
});

describe("analyticsConfigured", () => {
  it("is true only for a non-empty key", () => {
    expect(analyticsConfigured("phc_abc123")).toBe(true);
    expect(analyticsConfigured("   ")).toBe(false);
    expect(analyticsConfigured("")).toBe(false);
    expect(analyticsConfigured(undefined)).toBe(false);
    expect(analyticsConfigured(null)).toBe(false);
  });
});

describe("analyticsAllowed — the no-analytics-before-consent guarantee", () => {
  it("is true ONLY when configured AND granted", () => {
    expect(analyticsAllowed("granted", true)).toBe(true);
  });

  it("is false when not configured, even if granted", () => {
    // The key guard: a stray 'granted' cookie cannot start analytics if no
    // analytics are configured.
    expect(analyticsAllowed("granted", false)).toBe(false);
  });

  it("is false when denied or undecided", () => {
    expect(analyticsAllowed("denied", true)).toBe(false);
    expect(analyticsAllowed(null, true)).toBe(false);
  });
});

describe("shouldShowBanner", () => {
  it("shows only when configured and the user hasn't chosen yet", () => {
    expect(shouldShowBanner(null, true)).toBe(true);
  });

  it("stays hidden when not configured (nothing to consent to)", () => {
    expect(shouldShowBanner(null, false)).toBe(false);
  });

  it("stays hidden once a choice exists", () => {
    expect(shouldShowBanner("granted", true)).toBe(false);
    expect(shouldShowBanner("denied", true)).toBe(false);
  });
});

describe("isFirstPartySurface — portal/quote exclusion", () => {
  it("allows app + marketing surfaces", () => {
    expect(isFirstPartySurface("/")).toBe(true);
    expect(isFirstPartySurface("/dashboard")).toBe(true);
    expect(isFirstPartySurface("/privacy")).toBe(true);
    expect(isFirstPartySurface("/quotes/abc")).toBe(true); // tenant app, not /q
  });

  it("excludes the public quote pages and the customer portal", () => {
    expect(isFirstPartySurface("/q")).toBe(false);
    expect(isFirstPartySurface("/q/some-token")).toBe(false);
    expect(isFirstPartySurface("/customer-portal")).toBe(false);
    expect(isFirstPartySurface("/customer-portal/token/invoices")).toBe(false);
  });
});

describe("cookie read/write round-trip", () => {
  it("serialises with path, max-age and SameSite", () => {
    const s = serializeConsentCookie("granted");
    expect(s).toContain(`${CONSENT_COOKIE}=granted`);
    expect(s).toContain("path=/");
    expect(s).toContain(`max-age=${CONSENT_MAX_AGE_SEC}`);
    expect(s).toContain("SameSite=Lax");
  });

  it("reads the consent value out of a realistic cookie string", () => {
    const jar =
      "sb-access-token=xyz; cf_cookie_consent=denied; active_org_id=org_1";
    expect(readConsentFromCookieString(jar)).toBe("denied");
  });

  it("returns null when the consent cookie is absent or the jar is empty", () => {
    expect(readConsentFromCookieString("sb-access-token=xyz")).toBeNull();
    expect(readConsentFromCookieString("")).toBeNull();
  });
});
