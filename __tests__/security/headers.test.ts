import { describe, it, expect } from "vitest";
import { buildSecurityHeaders, type SecurityHeader } from "@/lib/security/headers";

/**
 * Security response-header contract (the next.config.ts fallback set).
 *
 * Locks the baseline hardening headers and that the build-time fallback CSP
 * is ENFORCED by default in production builds, with CSP_MODE=report-only as
 * the only (explicit) downgrade. The policy text itself is pinned in
 * __tests__/security/csp.test.ts.
 */

const byKey = (headers: SecurityHeader[]) =>
  Object.fromEntries(headers.map((h) => [h.key, h.value] as const));

const PROD_ENV = {
  NEXT_PUBLIC_APP_URL: "https://crewflow.uk",
  NEXT_PUBLIC_SUPABASE_URL: "https://abcdefgh.supabase.co",
};

describe("buildSecurityHeaders — baseline (all environments)", () => {
  for (const env of ["production", "development", "test", undefined] as const) {
    it(`always sets the four safe headers in env=${String(env)}`, () => {
      const h = byKey(buildSecurityHeaders(env, PROD_ENV));
      expect(h["X-Content-Type-Options"]).toBe("nosniff");
      expect(h["X-Frame-Options"]).toBe("DENY");
      expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
      expect(h["Permissions-Policy"]).toContain("geolocation=()");
      expect(h["Permissions-Policy"]).toContain("camera=()");
      expect(h["Permissions-Policy"]).toContain("microphone=()");
    });
  }

  it("never sets HSTS itself (Vercel owns Strict-Transport-Security)", () => {
    const h = byKey(buildSecurityHeaders("production", PROD_ENV));
    expect(h["Strict-Transport-Security"]).toBeUndefined();
  });
});

describe("buildSecurityHeaders — CSP gating + rollout switch", () => {
  it("ENFORCES the static CSP in production builds by default (CSP_MODE unset)", () => {
    const h = byKey(buildSecurityHeaders("production", PROD_ENV));
    expect(h["Content-Security-Policy"]).toBeDefined();
    expect(h["Content-Security-Policy-Report-Only"]).toBeUndefined();
    // The fallback is the nonce-free static policy (there is no request here).
    expect(h["Content-Security-Policy"]).not.toContain("'nonce-");
    expect(h["Content-Security-Policy"]).toContain("upgrade-insecure-requests");
    expect(h["Reporting-Endpoints"]).toBe('csp-endpoint="/api/csp-report"');
  });

  it("an unrecognised CSP_MODE value still enforces (typo-safe)", () => {
    for (const CSP_MODE of ["", "enforce", "reportonly", "off", "REPORT_ONLY"]) {
      const h = byKey(buildSecurityHeaders("production", { ...PROD_ENV, CSP_MODE }));
      expect(h["Content-Security-Policy"], CSP_MODE).toBeDefined();
      expect(h["Content-Security-Policy-Report-Only"], CSP_MODE).toBeUndefined();
    }
  });

  it("CSP_MODE=report-only downgrades to Report-Only (the no-code fallback)", () => {
    const h = byKey(buildSecurityHeaders("production", { ...PROD_ENV, CSP_MODE: " Report-Only " }));
    expect(h["Content-Security-Policy"]).toBeUndefined();
    expect(h["Content-Security-Policy-Report-Only"]).toContain("default-src 'self'");
  });

  it("omits the CSP in development (next dev needs eval for React Refresh)", () => {
    const h = byKey(buildSecurityHeaders("development", PROD_ENV));
    expect(h["Content-Security-Policy"]).toBeUndefined();
    expect(h["Content-Security-Policy-Report-Only"]).toBeUndefined();
    expect(h["Reporting-Endpoints"]).toBeUndefined();
  });

  it("does not upgrade insecure requests when the app URL is plain http (local E2E stack)", () => {
    const h = byKey(
      buildSecurityHeaders("production", { ...PROD_ENV, NEXT_PUBLIC_APP_URL: "http://localhost:3000" }),
    );
    expect(h["Content-Security-Policy"]).not.toContain("upgrade-insecure-requests");
  });
});
