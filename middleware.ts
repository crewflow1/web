import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

/**
 * Top-level middleware — delegates to the Supabase session helper.
 *
 * Block 2: session refresh + auth redirects.
 * Block 3+ may add: request-id headers, rate limiting, A/B flag injection.
 */
export async function middleware(request: NextRequest) {
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
