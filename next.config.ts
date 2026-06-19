import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { buildSecurityHeaders } from "./lib/security/headers";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.supabase.co" },
    ],
  },
  /**
   * Baseline security response headers on every route. The policy (incl. the
   * Report-Only CSP) lives in lib/security/headers.ts so it can be unit-tested
   * without booting this config. See that module for the full rationale.
   */
  async headers() {
    return [{ source: "/:path*", headers: buildSecurityHeaders() }];
  },
  /**
   * Route consolidation (CEO Directive 007.5). The AI Boardroom was merged
   * into the AI Employees SDK surface — its pages, actions and write forms now
   * live under /admin/ai-employees. These permanent redirects keep any stale
   * bookmark or deep link working after the merge.
   */
  async redirects() {
    return [
      {
        source: "/admin/ai-boardroom",
        destination: "/admin/ai-employees",
        permanent: true,
      },
      {
        source: "/admin/ai-boardroom/:slug*",
        destination: "/admin/ai-employees/:slug*",
        permanent: true,
      },
    ];
  },
};

/**
 * Sentry wrap — applies the Sentry webpack plugin in production builds
 * for source-map upload + release tagging. No-ops gracefully if the
 * auth token is absent, so local builds + missing-env-var deploys are
 * unaffected.
 *
 *   SENTRY_ORG       (default 'crewflow')
 *   SENTRY_PROJECT   (default 'web')
 *   SENTRY_AUTH_TOKEN (needed for source-map upload; preview+prod only)
 */
export default withSentryConfig(config, {
  org: process.env.SENTRY_ORG ?? "crewflow",
  project: process.env.SENTRY_PROJECT ?? "web",
  silent: !process.env.CI,
  hideSourceMaps: true,
  // If SENTRY_AUTH_TOKEN is unset the Sentry plugin emits a warning and
  // skips source-map upload but does not fail the build — exactly the
  // behaviour we want for local + cold-start preview deploys.
});
