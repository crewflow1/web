/**
 * Centralised security response headers, consumed by `next.config.ts`'s
 * `headers()` hook. Kept here as pure, side-effect-free data so the policy
 * can be unit-tested (see `__tests__/security/headers.test.ts`) without
 * booting the Next.js config loader.
 *
 * The Content-Security-Policy itself is built by `lib/security/csp.ts` (read
 * its module doc for the full policy rationale). This file attaches the
 * STATIC (nonce-free) policy to every response as the build-time FALLBACK —
 * it is what responses the middleware never sees carry (the PWA offline shell,
 * /sw.js, /pdf.worker.min.mjs, metadata routes, matcher-excluded API routes).
 * For every middleware-matched route, `middleware.ts` sets the same header
 * again per request (nonce policy on dynamic routes, the identical static
 * policy on prerendered ones), and the middleware value wins.
 */

import {
  buildCsp,
  cspHeaderName,
  reportingEndpointsValue,
  resolveCspMode,
  resolveCspSources,
  type CspMode,
} from "./csp";

export type SecurityHeader = { key: string; value: string };

/**
 * Baseline security response headers applied to every route.
 *
 * The first four are always on:
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
 * The CSP (+ its Reporting-Endpoints companion) is attached ONLY in
 * production builds. Local `next dev` relies on `eval` + `ws:` for HMR /
 * React Refresh. Preview and production — and the E2E tier (`next start`) —
 * are all production builds, so every surface under test receives it.
 *
 * @param nodeEnv  Defaults to `process.env.NODE_ENV`; pass explicitly in tests.
 * @param env      Environment the policy is resolved from (tests inject it).
 */
export function buildSecurityHeaders(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  env: Record<string, string | undefined> = process.env,
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
    const mode: CspMode = resolveCspMode(env.CSP_MODE);
    headers.push(
      {
        key: cspHeaderName(mode),
        value: buildCsp({
          sources: resolveCspSources(env),
          // Build-time: there is no request here, so key it off the canonical
          // app URL — https in preview/production, http on the local E2E stack.
          upgradeInsecureRequests: (env.NEXT_PUBLIC_APP_URL ?? "").startsWith("https://"),
        }),
      },
      { key: "Reporting-Endpoints", value: reportingEndpointsValue() },
    );
  }

  return headers;
}
