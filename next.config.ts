import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { buildSecurityHeaders } from "./lib/security/headers";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  /**
   * PERF (product UX rebuild): client Router Cache lifetimes. Next 15 defaults
   * `staleTimes.dynamic` to 0, so EVERY soft navigation to a dynamic segment
   * (all our (app) routes) re-hits the server — revisiting a page you just left,
   * or back/forward, always paid a fresh render. A modest dynamic window makes
   * "clicking around" instant while staying fresh:
   *   - dynamic 30s: a page revisited within 30s serves the cached RSC payload.
   *   - static 180s: rarely-changing segments cached longer.
   * Safe by construction — this only reuses an ALREADY-RENDERED, RLS-correct
   * payload for the SAME org: (a) org switch calls revalidatePath("/","layout")
   * which purges the whole router cache, so no cross-org staleness; (b) writes
   * navigate via full-document window.location.assign, which bypasses the cache,
   * so post-write freshness is preserved. Net: snappier read-navigation, no
   * correctness change.
   */
  experimental: {
    staleTimes: { dynamic: 30, static: 180 },
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.supabase.co" },
    ],
  },
  /**
   * Force-trace the artifacts the /admin/launch-checklist readiness probe
   * checks with `existsSync(resolve(process.cwd(), rel))`
   * (see server/services/launch-readiness.ts → fileExists()).
   *
   * Why this is needed: that page is `force-dynamic`, so the existence
   * checks run at REQUEST time inside the Vercel serverless lambda — not
   * at build time. The lambda filesystem ships only the compiled `.next`
   * output plus whatever @vercel/nft statically traced; raw source
   * (`.tsx` / `.md` / `.sql`) is absent. nft cannot follow the dynamic
   * path strings these checks build, so every check returned false in
   * production and the checklist showed RED even though all the features
   * exist and are deployed. Listing the exact files here copies them into
   * this route's lambda so the probe reflects reality.
   *
   * Keep this list in sync with the fileExists() calls in
   * server/services/launch-readiness.ts. The `**` segments match the
   * dynamic `[token]` and route-group `(app)` directories without glob
   * metacharacter escaping.
   */
  outputFileTracingIncludes: {
    "/admin/launch-checklist": [
      "docs/SECURITY.md",
      "lib/security/rate-limit.ts",
      "scripts/e2e-lifecycle.sql",
      "app/admin/ops/page.tsx",
      "app/admin/automations/page.tsx",
      "app/customer-portal/**/jobs/page.tsx",
      "app/customer-portal/**/messages/page.tsx",
      "app/**/onboarding/setup/page.tsx",
      "app/api/ai/question/route.ts",
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
   * Redesign: the AI-receptionist feature page was removed (the capability is
   * built-dark — telephony/voice is not a live customer feature). 301 its
   * indexed URL to the CRM page so search equity and any external links are
   * preserved rather than 404'd.
   */
  async redirects() {
    return [
      {
        source: "/features/ai-receptionist",
        destination: "/features/construction-crm",
        permanent: true,
      },
    ];
  },
  /**
   * pdf.js (the Blueprint interactive viewer, client-only + dynamically imported)
   * references an OPTIONAL Node `canvas` package it never needs in the browser.
   * Alias it away so Webpack doesn't try to resolve a native module. This is a
   * build-resolution alias, NOT a security change. The pdf.js worker itself is
   * copied to /public/pdf.worker.min.mjs by the `prebuild`/`predev` script and
   * loaded same-origin (satisfies the existing `worker-src 'self'` CSP).
   */
  webpack: (webpackConfig) => {
    webpackConfig.resolve = webpackConfig.resolve ?? {};
    webpackConfig.resolve.alias = { ...(webpackConfig.resolve.alias ?? {}), canvas: false };
    return webpackConfig;
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
