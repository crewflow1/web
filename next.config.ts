import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

/**
 * Content-Security-Policy (Report-Only for now).
 *
 * Shipped in `-Report-Only` mode first: browsers REPORT violations to the
 * console but do not block anything, so we can observe what the app
 * actually needs across every surface (marketing, auth, dashboard, Stripe
 * checkout) before switching to an enforcing `Content-Security-Policy`.
 *
 * Origin allow-list rationale (everything else is denied by default-src):
 *   - Supabase  (https + wss *.supabase.co): REST, Auth, Realtime, Storage.
 *   - PostHog   (eu.i.posthog.com / eu-assets…): product analytics beacons
 *               + lazily-loaded config. EU region (see lib/analytics/load.ts).
 *   - Sentry    (*.ingest[.de|.us].sentry.io, *.sentry.io): error ingestion.
 *               Region isn't pinned in config, so all ingest regions allowed.
 *   - Vercel    (vercel.live, vitals.vercel-insights.com): preview feedback
 *               widget + (if enabled) Speed Insights beacons.
 *   - Stripe    (checkout/billing.stripe.com in form-action): hosted Checkout
 *               is a top-level REDIRECT — there is NO client-side Stripe.js /
 *               Elements in this app, so no script-src/frame-src entry needed.
 *
 * 'unsafe-inline' is required for script/style because Next.js App Router
 * emits inline hydration scripts and inline styles without nonces today;
 * migrating to nonces (and dropping 'unsafe-inline' from script-src) is the
 * intended follow-up once this Report-Only policy is validated in prod.
 * 'unsafe-eval' is deliberately OMITTED so Report-Only tells us whether any
 * dependency actually needs it.
 */
const CSP_REPORT_ONLY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
  "script-src 'self' 'unsafe-inline' https://eu-assets.i.posthog.com https://vercel.live",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.supabase.co https://eu.i.posthog.com",
  "font-src 'self' data:",
  [
    "connect-src 'self'",
    "https://*.supabase.co wss://*.supabase.co",
    "https://eu.i.posthog.com https://eu-assets.i.posthog.com",
    "https://*.ingest.sentry.io https://*.ingest.de.sentry.io https://*.ingest.us.sentry.io https://*.sentry.io",
    "https://vitals.vercel-insights.com https://vercel.live wss://*.pusher.com",
  ].join(" "),
  "media-src 'self' blob: data: https://*.supabase.co",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-src 'self' https://vercel.live",
  "upgrade-insecure-requests",
].join("; ");

/**
 * Baseline security response headers, applied to every route.
 *
 * These three + Permissions-Policy are safe to ENFORCE immediately:
 *   - nosniff blocks MIME-type confusion attacks.
 *   - X-Frame-Options: DENY — nothing in this app is meant to be framed
 *     (the customer portal & quote-share pages are standalone token pages,
 *     verified: no <iframe> embeds of our own routes), and `frame-ancestors
 *     'none'` in the CSP is the modern equivalent.
 *   - Referrer-Policy avoids leaking full URLs (which carry tokens) to
 *     third parties.
 *   - Permissions-Policy disables browser features the app never uses
 *     (verified: no getUserMedia / geolocation in the client).
 *
 * HSTS is intentionally NOT set here — Vercel already serves
 * `Strict-Transport-Security: max-age=63072000` on the apex domain, and
 * overriding it (esp. adding includeSubDomains/preload) is a separate,
 * harder-to-reverse decision.
 */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
  { key: "Content-Security-Policy-Report-Only", value: CSP_REPORT_ONLY },
];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.supabase.co" },
    ],
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
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
