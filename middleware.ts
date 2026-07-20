import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import {
  isMaintenanceMode,
  isMaintenanceBypassed,
  maintenanceResponse,
} from "@/lib/maintenance";

/**
 * Top-level middleware — delegates to the Supabase session helper.
 *
 * Block 1: maintenance-window gate (DB-free) — during a controlled cutover,
 *   customer/app routes return a retry-safe 503 BEFORE any session/DB work, so
 *   it is safe to serve even while the schema is mid-migration. Operators and
 *   smoke-tests bypass with the MAINTENANCE_BYPASS token. Inert unless
 *   MAINTENANCE_MODE=on. api/health, api/cron and api/webhooks are excluded by
 *   the matcher below and gated separately (they must stay reachable / retry-safe).
 * Block 2: session refresh + auth redirects.
 */
export async function middleware(request: NextRequest) {
  if (isMaintenanceMode() && !isMaintenanceBypassed(request)) {
    const wantsHtml = (request.headers.get("accept") ?? "").includes("text/html");
    return maintenanceResponse(wantsHtml ? "html" : "json");
  }
  return await updateSession(request);
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
  //   - api/health         → public liveness probe
  //   - api/cron           → CRON_SECRET bearer (lib/cron/auth.ts)
  //   - api/demo           → public lead-capture form
  //   - api/webhooks       → vendor-signed payloads (e.g. Stripe-Signature)
  //   - api/receptionist   → channel-secret header (x-crewflow-channel-secret).
  //                          Inbound calls from Twilio / WhatsApp / Meta will
  //                          NEVER have a Supabase session cookie, so the
  //                          middleware MUST NOT redirect to /login.
  //
  // The middleware MUST NOT redirect these to /login or vendor signature
  // verification never gets a chance to run and the webhook delivery fails
  // with 307.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|manifest.webmanifest|icon.svg|opengraph-image|api/og|api/health|api/cron|api/demo|api/webhooks|api/receptionist).*)",
  ],
};
