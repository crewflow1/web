/**
 * Centralised security response headers, consumed by `next.config.ts`'s
 * `headers()` hook. Kept here as pure, side-effect-free data so the policy
 * can be unit-tested (see `__tests__/security/headers.test.ts`) without
 * booting the Next.js config loader.
 *
 * ---------------------------------------------------------------------------
 * Content-Security-Policy — shipped REPORT-ONLY first
 * ---------------------------------------------------------------------------
 * In `Content-Security-Policy-Report-Only` mode browsers REPORT violations
 * (to the devtools console) but block nothing, so we can observe what the
 * app actually needs across every surface — marketing, auth, the
 * authenticated dashboard, and the Stripe checkout redirect — before
 * switching to an enforcing `Content-Security-Policy` in a follow-up.
 *
 * Origin allow-list rationale (everything else is denied by default-src):
 *   - Supabase  (https + wss *.supabase.co): REST, Auth, Realtime, Storage.
 *   - PostHog   (eu.i.posthog.com / eu-assets.i.posthog.com): product
 *               analytics beacons + lazily-loaded config. EU region — see
 *               lib/analytics/load.ts. (posthog-js is bundled via npm, so it
 *               needs connect/img, not a remote <script>; eu-assets is kept
 *               in script-src defensively for PostHog's optional config JS.)
 *   - Sentry    (*.ingest[.de|.us].sentry.io, *.sentry.io): error ingestion.
 *               The DSN region isn't pinned in config, so all regions allow.
 *   - Vercel    (vercel.live + *.pusher.com, vitals.vercel-insights.com):
 *               the preview-deployment feedback toolbar (websockets via
 *               Pusher) and, if ever enabled, Speed-Insights beacons. These
 *               are inert on the production apex (no toolbar there) but are
 *               listed so PREVIEW validation isn't drowned in toolbar noise.
 *   - Stripe    (checkout/billing.stripe.com in form-action only): hosted
 *               Checkout is a top-level REDIRECT. There is NO client-side
 *               Stripe.js / Elements in this app (verified: zero js.stripe.com
 *               / loadStripe references), so no script-src/frame-src entry.
 *
 * `'unsafe-inline'` is required for script/style because the Next.js App
 * Router emits inline hydration scripts and inline styles without nonces
 * today, and the homepage renders a JSON-LD <script>. Migrating to nonces
 * (and dropping `'unsafe-inline'` from script-src) is the intended follow-up
 * once this Report-Only policy is validated in production.
 *
 * `'unsafe-eval'` is deliberately OMITTED so the Report-Only stream tells us
 * whether any dependency genuinely needs it. `'wasm-unsafe-eval'` IS present
 * (added for the Blueprint pdf.js viewer, whose bundled OpenJPEG/JBIG2 image
 * codecs decode via WebAssembly): it permits `WebAssembly.compile/instantiate`
 * from bytes ONLY — NOT string→JS eval — so it is far narrower than the
 * `'unsafe-inline'` already shipped, and pdf.js is configured with
 * `isEvalSupported:false` so it never needs `'unsafe-eval'` itself.
 *
 * `upgrade-insecure-requests` is intentionally absent: it is IGNORED inside a
 * report-only policy (browsers emit a console warning), so it belongs only in
 * the future enforcing policy.
 */

export type SecurityHeader = { key: string; value: string };

/** The Report-Only Content-Security-Policy. See the module doc for rationale. */
export const CSP_REPORT_ONLY: string = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://eu-assets.i.posthog.com https://vercel.live",
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
].join("; ");

/**
 * Baseline security response headers applied to every route.
 *
 * The first four are safe to ENFORCE immediately:
 *   - X-Content-Type-Options: nosniff — blocks MIME-type confusion attacks.
 *   - X-Frame-Options: DENY — nothing in this app is meant to be framed (the
 *     customer-portal and quote-share pages are standalone token pages;
 *     verified: no <iframe> embeds of our own routes). `frame-ancestors
 *     'none'` in the CSP is the modern equivalent.
 *   - Referrer-Policy — avoids leaking full URLs (which can carry tokens) to
 *     third parties.
 *   - Permissions-Policy — disables browser features the app never uses
 *     (verified: no getUserMedia / geolocation in the client).
 *
 * HSTS is intentionally NOT set here: Vercel already serves
 * `Strict-Transport-Security: max-age=63072000` on the apex domain, and
 * overriding it (especially adding includeSubDomains / preload) is a
 * separate, harder-to-reverse decision.
 *
 * The Report-Only CSP is attached ONLY in production builds. Local
 * `next dev` uses `eval` + `ws:` for HMR / React Refresh, which would spam
 * the console with report-only violations that don't reflect production.
 * Preview and production are both production builds, so the surfaces we need
 * to validate still receive the policy.
 *
 * @param nodeEnv  Defaults to `process.env.NODE_ENV`; pass explicitly in tests.
 */
export function buildSecurityHeaders(
  nodeEnv: string | undefined = process.env.NODE_ENV,
): SecurityHeader[] {
  const headers: SecurityHeader[] = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    {
      key: "Permissions-Policy",
      value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
    },
  ];

  if (nodeEnv === "production") {
    headers.push({
      key: "Content-Security-Policy-Report-Only",
      value: CSP_REPORT_ONLY,
    });
  }

  return headers;
}
