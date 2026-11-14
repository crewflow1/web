import { describe, it, expect } from "vitest";
import {
  CONSENT_CATEGORIES,
  CONSENT_COOKIE,
  CONSENT_MAX_AGE_SEC,
  CONSENT_VERSION,
  allDenied,
  allGranted,
  analyticsAllowed,
  analyticsConfigured,
  buildConsentRecord,
  categoryAllowed,
  configuredCategories,
  cookieDomainCandidates,
  isAnalyticsStorageKey,
  isFirstPartySurface,
  needsDecision,
  parseConsent,
  parseConsentRecord,
  readConsentFromCookieString,
  readConsentRecordFromCookieString,
  serializeConsentCookie,
  serializeConsentValue,
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

  it("excludes the external-worker portal and the public enquiry form", () => {
    // Their visitors are a contractor's workers / customers, not CrewFlow
    // users, and the worker link carries an access token in the URL.
    expect(isFirstPartySurface("/worker-portal")).toBe(false);
    expect(isFirstPartySurface("/worker-portal/some-token")).toBe(false);
    expect(isFirstPartySurface("/l")).toBe(false);
    expect(isFirstPartySurface("/l/acme-builders")).toBe(false);
  });

  it("matches whole path segments only (no prefix over-reach)", () => {
    expect(isFirstPartySurface("/login")).toBe(true); // not /l
    expect(isFirstPartySurface("/leads")).toBe(true); // not /l
    expect(isFirstPartySurface("/qualifications")).toBe(true); // not /q
    expect(isFirstPartySurface("/worker-portals")).toBe(true);
  });
});

describe("cookie read/write round-trip", () => {
  it("serialises with path, max-age and SameSite", () => {
    const record = buildConsentRecord(allGranted(), new Date("2026-11-13T10:00:00Z"));
    const s = serializeConsentCookie(record);
    expect(s).toContain(`${CONSENT_COOKIE}=${serializeConsentValue(record)}`);
    expect(s).toContain("path=/");
    expect(s).toContain(`max-age=${CONSENT_MAX_AGE_SEC}`);
    expect(s).toContain("SameSite=Lax");
    expect(s).not.toContain("Secure");
  });

  it("adds Secure on https origins only when asked", () => {
    const record = buildConsentRecord(allDenied());
    expect(serializeConsentCookie(record, { secure: true })).toMatch(/; Secure$/);
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

/**
 * The consent RECORD (v2): version + timestamp + per-category choice.
 *
 * What must hold:
 *   - it round-trips through the cookie value losslessly;
 *   - parsing FAILS CLOSED — nothing malformed can ever read as a grant;
 *   - a legacy v1 cookie keeps exactly the meaning it had (analytics only);
 *   - each category is allowed ONLY when configured AND granted;
 *   - the banner is due exactly when a decision is genuinely outstanding.
 */

const NOW = new Date("2026-11-13T10:00:00.000Z");

describe("consent record — serialise / parse", () => {
  it("round-trips version, timestamp and every category", () => {
    const record = buildConsentRecord({ analytics: true, performance: false }, NOW);
    expect(record.version).toBe(CONSENT_VERSION);
    expect(record.decidedAt).toBe("2026-11-13T10:00:00.000Z");

    const value = serializeConsentValue(record);
    expect(value).toBe("v2.t1794564000.analytics1.performance0");
    expect(parseConsentRecord(value)).toEqual(record);
  });

  it("uses only cookie-safe characters (no encoding needed)", () => {
    const value = serializeConsentValue(buildConsentRecord(allGranted(), NOW));
    expect(value).toMatch(/^[A-Za-z0-9.]+$/);
  });

  it("buildConsentRecord grants only an explicit true", () => {
    const record = buildConsentRecord(
      { analytics: "yes" as unknown as boolean, performance: undefined },
      NOW,
    );
    expect(record.categories).toEqual(allDenied());
  });

  it("maps the legacy v1 cookie: granted → analytics only, denied → nothing", () => {
    expect(parseConsentRecord("granted")).toEqual({
      version: 1,
      decidedAt: null,
      categories: { analytics: true, performance: false },
    });
    expect(parseConsentRecord("denied")).toEqual({
      version: 1,
      decidedAt: null,
      categories: allDenied(),
    });
  });

  it("fails closed on anything malformed", () => {
    for (const bad of [
      "",
      "yes",
      "true",
      "v2",
      "v2.t0.analytics1", // no real timestamp
      "v1.t1794564000.analytics1", // v1 never had this shape
      "v2.1794564000.analytics1", // missing t prefix
      "v2.t1794564000.analytics2", // not 0/1
      "v2.t1794564000.analytics", // no value
      "v2.t1794564000.analyticstrue",
      "v2.t1794564000.ANALYTICS1",
      "x2.t1794564000.analytics1",
    ]) {
      expect(parseConsentRecord(bad), bad).toBeNull();
    }
    expect(parseConsentRecord(null)).toBeNull();
    expect(parseConsentRecord(undefined)).toBeNull();
  });

  it("a category missing from the value is denied, an unknown one is ignored", () => {
    const record = parseConsentRecord("v2.t1794564000.analytics1.marketing1");
    expect(record?.categories).toEqual({ analytics: true, performance: false });
  });

  it("reads the record (and the analytics shorthand) out of a cookie jar", () => {
    const jar =
      "sb-access-token=xyz; cf_cookie_consent=v2.t1794564000.analytics0.performance1; active_org_id=org_1";
    expect(readConsentRecordFromCookieString(jar)?.categories).toEqual({
      analytics: false,
      performance: true,
    });
    expect(readConsentFromCookieString(jar)).toBe("denied");
    expect(
      readConsentFromCookieString("cf_cookie_consent=v2.t1794564000.analytics1.performance0"),
    ).toBe("granted");
    // legacy cookie still reads the same way
    expect(readConsentFromCookieString("cf_cookie_consent=granted")).toBe("granted");
  });

  it("treats undecodable cookie bytes as no choice", () => {
    expect(readConsentRecordFromCookieString("cf_cookie_consent=%E0%A4%A")).toBeNull();
  });
});

describe("configuredCategories", () => {
  it("offers a category only when its vendor is configured", () => {
    expect(configuredCategories({ posthogKey: undefined, monitoringEnabled: false })).toEqual([]);
    expect(configuredCategories({ posthogKey: "phc_x", monitoringEnabled: false })).toEqual([
      "analytics",
    ]);
    expect(configuredCategories({ posthogKey: "  ", monitoringEnabled: true })).toEqual([
      "performance",
    ]);
    expect(configuredCategories({ posthogKey: "phc_x", monitoringEnabled: true })).toEqual([
      ...CONSENT_CATEGORIES,
    ]);
  });
});

describe("categoryAllowed — default-denied, per category", () => {
  const both = [...CONSENT_CATEGORIES];

  it("is false for every category when there is no record", () => {
    for (const c of CONSENT_CATEGORIES) expect(categoryAllowed(null, c, both)).toBe(false);
  });

  it("follows each category independently (mixed choice)", () => {
    const mixed = buildConsentRecord({ analytics: true, performance: false }, NOW);
    expect(categoryAllowed(mixed, "analytics", both)).toBe(true);
    expect(categoryAllowed(mixed, "performance", both)).toBe(false);

    const inverse = buildConsentRecord({ analytics: false, performance: true }, NOW);
    expect(categoryAllowed(inverse, "analytics", both)).toBe(false);
    expect(categoryAllowed(inverse, "performance", both)).toBe(true);
  });

  it("is false for a granted category that is not configured", () => {
    const all = buildConsentRecord(allGranted(), NOW);
    expect(categoryAllowed(all, "analytics", ["performance"])).toBe(false);
    expect(categoryAllowed(all, "performance", [])).toBe(false);
  });

  it("a legacy 'granted' never unlocks a category it was not asked about", () => {
    const legacy = parseConsentRecord("granted");
    expect(categoryAllowed(legacy, "analytics", both)).toBe(true);
    expect(categoryAllowed(legacy, "performance", both)).toBe(false);
  });
});

describe("needsDecision — when the banner is due", () => {
  const both = [...CONSENT_CATEGORIES];

  it("never when nothing optional is configured", () => {
    expect(needsDecision(null, [])).toBe(false);
  });

  it("always when there is no stored choice", () => {
    expect(needsDecision(null, both)).toBe(true);
    expect(needsDecision(null, ["analytics"])).toBe(true);
  });

  it("not once a current-version choice exists (accept, reject or mixed)", () => {
    expect(needsDecision(buildConsentRecord(allGranted(), NOW), both)).toBe(false);
    expect(needsDecision(buildConsentRecord(allDenied(), NOW), both)).toBe(false);
    expect(needsDecision(buildConsentRecord({ analytics: true }, NOW), both)).toBe(false);
  });

  it("re-asks a legacy 'granted' (the categories changed) but not a legacy 'denied'", () => {
    expect(needsDecision(parseConsentRecord("granted"), both)).toBe(true);
    expect(needsDecision(parseConsentRecord("denied"), both)).toBe(false);
  });
});

describe("withdrawal clean-up helpers", () => {
  it("recognises analytics-vendor storage keys and nothing first-party", () => {
    expect(isAnalyticsStorageKey("ph_phc_abc_posthog")).toBe(true);
    expect(isAnalyticsStorageKey("ph_phc_abc_window_id")).toBe(true);
    expect(isAnalyticsStorageKey("__ph_opt_in_out_phc_abc")).toBe(true);
    for (const ours of [
      "cf_cookie_consent",
      "cf-nav-expanded",
      "cf-cmd-recents",
      "crewflow-offline-identity",
      "sb-127-auth-token",
      "active_org_id",
      "cf_impersonation_session",
      "photos",
    ]) {
      expect(isAnalyticsStorageKey(ours), ours).toBe(false);
    }
  });

  it("lists every domain a vendor cookie could sit on", () => {
    expect(cookieDomainCandidates("crewflow.uk")).toEqual(["", "crewflow.uk", ".crewflow.uk"]);
    expect(cookieDomainCandidates("app.crewflow.uk")).toEqual([
      "",
      "app.crewflow.uk",
      ".app.crewflow.uk",
      "crewflow.uk",
      ".crewflow.uk",
    ]);
    // host-only for single-label hosts and IP literals
    expect(cookieDomainCandidates("localhost")).toEqual([""]);
    expect(cookieDomainCandidates("127.0.0.1")).toEqual([""]);
    expect(cookieDomainCandidates("")).toEqual([""]);
  });
});
