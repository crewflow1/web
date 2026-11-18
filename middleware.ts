import { NextResponse, type NextRequest } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { updateSession } from "@/lib/supabase/middleware";
import {
  isMaintenanceMode,
  isMaintenanceBypassed,
  maintenanceResponse,
} from "@/lib/maintenance";
import { REQUEST_ID_HEADER, resolveRequestId } from "@/lib/api/request-id";
import {
  NONCE_HEADER,
  buildCsp,
  cspClassForPath,
  cspHeaderName,
  generateNonce,
  isCspClassBoundaryCrossing,
  reportingEndpointsValue,
  resolveCspMode,
  resolveCspSources,
} from "@/lib/security/csp";

/**
 * Per-request Content-Security-Policy (see lib/security/csp.ts for the policy
 * and the nonce-vs-static rationale). Production builds only — `next dev`
 * needs eval for React Refresh, exactly like the next.config fallback.
 *
 * Mode + origins are resolved once per isolate: they come from env, which is
 * fixed for a deployment (CSP_MODE=report-only + redeploy = rollback switch).
 */
const CSP_ENABLED = process.env.NODE_ENV === "production";
const CSP_MODE = resolveCspMode();
const CSP_SOURCES = resolveCspSources();

type CspPlan = { headerName: string; value: string; nonce: string | null; origin: string };

function planCsp(request: NextRequest): CspPlan | null {
  if (!CSP_ENABLED) return null;
  const nonce = cspClassForPath(request.nextUrl.pathname) === "nonce" ? generateNonce() : null;
  return {
    headerName: cspHeaderName(CSP_MODE),
    value: buildCsp({
      nonce: nonce ?? undefined,
      sources: CSP_SOURCES,
      upgradeInsecureRequests: request.nextUrl.protocol === "https:",
    }),
    nonce,
    origin: request.nextUrl.origin,
  };
}

/** Stamp the policy (+ its Reporting-Endpoints companion) on a response. */
function applyCsp<T extends Response>(res: T, plan: CspPlan | null): T {
  if (plan) {
    res.headers.set(plan.headerName, plan.value);
    res.headers.set("Reporting-Endpoints", reportingEndpointsValue(plan.origin));
  }
  return res;
}

/**
 * Top-level middleware — request correlation + delegates to the Supabase
 * session helper.
 *
 * Block 0: REQUEST-ID. Mint (or reuse a well-formed inbound) `x-request-id`
 *   once per request. It is (a) forwarded onto the request so route handlers /
 *   server code echo it via lib/api/respond.ts, (b) emitted on the response so
 *   clients + logs can correlate, and (c) attached to the Sentry scope so an
 *   error report carries the same id the user/CLI saw. Sentry is dark-safe: the
 *   tag call is a cheap no-op when the SDK isn't initialised (no DSN), so this
 *   never adds cost or leaks when monitoring is off. The id is a random UUID
 *   (or a validated opaque inbound token) — never PII — so it is safe to log.
 * Block 1: maintenance-window gate (DB-free) — during a controlled cutover,
 *   customer/app routes return a retry-safe 503 BEFORE any session/DB work, so
 *   it is safe to serve even while the schema is mid-migration. Operators and
 *   smoke-tests bypass with the MAINTENANCE_BYPASS token. Inert unless
 *   MAINTENANCE_MODE=on. api/health, api/cron and api/webhooks are excluded by
 *   the matcher below and gated separately (they must stay reachable / retry-safe).
 * Block 2: CONTENT-SECURITY-POLICY. Mint the per-request nonce policy (or the
 *   static policy for prerendered pages) and stamp it on the response — and,
 *   for nonce routes, forward it on the request so Next.js nonces its scripts.
 *   A client-side navigation from a static-policy document onto a nonce route
 *   is answered with a non-RSC 204, which makes the Next router do a full
 *   document load, so the destination runs under its own strict policy.
 * Block 3: session refresh + auth redirects.
 */
export async function middleware(request: NextRequest) {
  const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));

  // Best-effort correlation tag. No-op unless Sentry is initialised (dark-safe).
  try {
    Sentry.getCurrentScope().setTag("request_id", requestId);
  } catch {
    // Never let monitoring wiring break a request.
  }

  const csp = planCsp(request);

  if (isMaintenanceMode() && !isMaintenanceBypassed(request)) {
    const wantsHtml = (request.headers.get("accept") ?? "").includes("text/html");
    const res = maintenanceResponse(wantsHtml ? "html" : "json");
    res.headers.set(REQUEST_ID_HEADER, requestId);
    return applyCsp(res, csp);
  }

  if (
    csp &&
    isCspClassBoundaryCrossing({
      method: request.method,
      pathname: request.nextUrl.pathname,
      nextUrlHeader: request.headers.get("next-url"),
      nextActionHeader: request.headers.get("next-action"),
    })
  ) {
    // Not an RSC payload → the Next router falls back to a full navigation.
    const res = new NextResponse(null, {
      status: 204,
      headers: { "Cache-Control": "no-store", Vary: "RSC, Next-Url" },
    });
    res.headers.set(REQUEST_ID_HEADER, requestId);
    return applyCsp(res, csp);
  }

  const forward = csp?.nonce
    ? { [csp.headerName.toLowerCase()]: csp.value, [NONCE_HEADER]: csp.nonce }
    : undefined;
  return applyCsp(await updateSession(request, requestId, forward), csp);
}

export const config = {
  // Skip Next internals, static files, and routes that authenticate via
  // their own mechanism rather than the Supabase session cookie:
  //   - favicon.ico / robots.txt / sitemap.xml / manifest.webmanifest /
  //     icon.svg / opengraph-image
  //                        → public files & SEO metadata routes. These MUST
  //                          be served to anonymous crawlers; without the
  //                          exclusion the auth middleware 307-redirects them
  //                          to /login, so search engines can't read the
  //                          robots rules, find the sitemap, or fetch the
  //                          social share image.
  //   - pdf.worker.min.mjs → the pdf.js web-worker bundle for the Blueprint
  //                          viewer (a public library asset, no tenant data).
  //                          The browser fetches it as a module Worker; if a
  //                          session cookie is expired/mid-refresh, a 307 to
  //                          /login would hand pdf.js an HTML page as its
  //                          worker source and the viewer would fail cryptically
  //                          instead of rendering. Static asset → must bypass
  //                          auth, and skips a wasted Supabase round-trip per
  //                          1.3 MB fetch.
  //   - api/csp-report     → browser CSP violation reports: sent without a
  //                          session by design; a 307 to /login would drop
  //                          every report (rate-limited + size-capped in-route).
  //   - api/health         → public liveness probe
  //   - api/cron           → CRON_SECRET bearer (lib/cron/auth.ts)
  //   - api/demo           → public lead-capture form
  //   - api/webhooks       → vendor-signed payloads (e.g. Stripe-Signature)
  //   - api/receptionist   → channel-secret header (x-crewflow-channel-secret).
  //                          Inbound calls from Twilio / WhatsApp / Meta will
  //                          NEVER have a Supabase session cookie, so the
  //                          middleware MUST NOT redirect to /login.
  //   - api/v1             → public API: key-authed (Authorization: Bearer
  //                          crw_…) and 404-while-dark at the route guard; a
  //                          machine client can never carry a session cookie.
  //   - api/sso            → SAML ACS / OIDC callback: the IdP POSTs an
  //                          assertion — the whole point is the user has no
  //                          session YET. Routes 404 while the org's SSO is
  //                          off and validate assertions fail-closed.
  //   - scim/v2            → SCIM provisioning: IdP-to-server bearer-token
  //                          protocol (401 without the minted token; 401
  //                          while dark). Discovered live: the auth
  //                          middleware 307'd all three machine surfaces to
  //                          /login, making them unusable regardless of
  //                          flags — the built-dark class this exclusion
  //                          list exists for, invisible until a real probe.
  //
  // The middleware MUST NOT redirect these to /login or vendor signature
  // verification never gets a chance to run and the webhook delivery fails
  // with 307.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|manifest.webmanifest|icon.svg|opengraph-image|pdf.worker.min.mjs|sw.js|offline|icons/|api/og|api/csp-report|api/health|api/cron|api/demo|api/public|api/webhooks|api/receptionist|api/v1|api/sso|scim/v2).*)",
  ],
};
