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
