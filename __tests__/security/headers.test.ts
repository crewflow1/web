import { describe, it, expect } from "vitest";
import {
  buildSecurityHeaders,
  CSP_REPORT_ONLY,
  type SecurityHeader,
} from "@/lib/security/headers";

/**
 * Security response-header contract.
 *
 * Locks the baseline hardening headers and the (currently Report-Only)
 * Content-Security-Policy so regressions — especially an ACCIDENTAL flip
 * from Report-Only to an enforcing CSP before the policy has been validated
 * in production — fail CI loudly.
 */

const byKey = (headers: SecurityHeader[]) =>
  Object.fromEntries(headers.map((h) => [h.key, h.value] as const));

describe("buildSecurityHeaders — baseline (all environments)", () => {
  for (const env of ["production", "development", "test", undefined] as const) {
    it(`always enforces the four safe headers in env=${String(env)}`, () => {
      const h = byKey(buildSecurityHeaders(env));
      expect(h["X-Content-Type-Options"]).toBe("nosniff");
      expect(h["X-Frame-Options"]).toBe("DENY");
      expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
      expect(h["Permissions-Policy"]).toContain("geolocation=()");
      expect(h["Permissions-Policy"]).toContain("camera=()");
      expect(h["Permissions-Policy"]).toContain("microphone=()");
    });
  }

  it("never sets HSTS itself (Vercel owns Strict-Transport-Security)", () => {
    const h = byKey(buildSecurityHeaders("production"));
    expect(h["Strict-Transport-Security"]).toBeUndefined();
  });
});

describe("buildSecurityHeaders — CSP gating", () => {
  it("attaches the Report-Only CSP in production builds", () => {
    const h = byKey(buildSecurityHeaders("production"));
    expect(h["Content-Security-Policy-Report-Only"]).toBe(CSP_REPORT_ONLY);
  });

  it("omits the CSP in development (keeps next dev console clean)", () => {
    const h = byKey(buildSecurityHeaders("development"));
    expect(h["Content-Security-Policy-Report-Only"]).toBeUndefined();
  });

  it("NEVER emits an enforcing Content-Security-Policy (guard against early enforce)", () => {
    for (const env of ["production", "development", "test"] as const) {
      const h = byKey(buildSecurityHeaders(env));
      expect(h["Content-Security-Policy"]).toBeUndefined();
    }
  });
});

describe("CSP_REPORT_ONLY — directive contract", () => {
  const directives = CSP_REPORT_ONLY.split(";").map((d) => d.trim());
  const find = (name: string) =>
    directives.find((d) => d === name || d.startsWith(`${name} `));

  it("locks down the dangerous defaults", () => {
    expect(find("default-src")).toBe("default-src 'self'");
    expect(find("base-uri")).toBe("base-uri 'self'");
    expect(find("object-src")).toBe("object-src 'none'");
    expect(find("frame-ancestors")).toBe("frame-ancestors 'none'");
  });

  it("allows the Supabase REST + realtime origins in connect-src", () => {
    const connect = find("connect-src") ?? "";
    expect(connect).toContain("https://*.supabase.co");
    expect(connect).toContain("wss://*.supabase.co");
  });

  it("allows PostHog + Sentry telemetry endpoints in connect-src", () => {
    const connect = find("connect-src") ?? "";
    expect(connect).toContain("https://eu.i.posthog.com");
    expect(connect).toContain("sentry.io");
  });

  it("permits Supabase Storage images", () => {
    const img = find("img-src") ?? "";
    expect(img).toContain("https://*.supabase.co");
  });

  it("requires 'unsafe-inline' for scripts/styles today (Next inline + JSON-LD)", () => {
    expect(find("script-src")).toContain("'unsafe-inline'");
    expect(find("style-src")).toContain("'unsafe-inline'");
  });

  it("does NOT weaken script-src with 'unsafe-eval' (string→JS eval)", () => {
    // 'wasm-unsafe-eval' does not contain the substring 'unsafe-eval' (leading
    // quote differs), so this correctly forbids only the dangerous full eval.
    expect(CSP_REPORT_ONLY).not.toContain("'unsafe-eval'");
  });

  it("allows 'wasm-unsafe-eval' for the pdf.js viewer's WASM image codecs (narrower than 'unsafe-inline' already shipped)", () => {
    expect(find("script-src")).toContain("'wasm-unsafe-eval'");
  });

  it("does NOT include upgrade-insecure-requests (ignored in report-only)", () => {
    expect(directives).not.toContain("upgrade-insecure-requests");
  });

  it("scopes Stripe to form-action only (no client-side Stripe.js)", () => {
    expect(find("form-action")).toContain("https://checkout.stripe.com");
    expect(CSP_REPORT_ONLY).not.toContain("js.stripe.com");
  });
});
