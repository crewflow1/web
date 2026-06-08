import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
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
