import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { User } from "@supabase/supabase-js";
import type { Database } from "./types";
import { REQUEST_ID_HEADER } from "@/lib/api/request-id";

/** Forwarded so server code (requireOrgContext) can read the resolved path
 * without re-parsing — used to allow-list the MFA enrol/challenge destinations
 * so enforcement never loops. */
export const PATHNAME_HEADER = "x-pathname";

type CookieToSet = { name: string; value: string; options?: CookieOptions };

/**
 * Session refresh + redirect rules for middleware.
 *
 * Runs on every request matched by middleware.ts.
 *
 * Responsibilities:
 *   1. Refresh the Supabase session cookie if it's expired or about to expire.
 *   2. Redirect unauthenticated visitors away from protected routes.
 *   3. Redirect authenticated visitors away from /login & /signup.
 *
 * The "do they have an org?" check is intentionally done in the
 * (app) and onboarding layouts instead of here — that keeps middleware
 * fast and avoids a DB query on every public-page request.
 *
 * Env vars are read into constants and asserted explicitly so a missing
 * anon key fails loudly here instead of every request silently shipping
 * a Supabase client with an undefined apikey.
 */
export async function updateSession(request: NextRequest, requestId?: string) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  }
  if (!supabaseAnonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  // Forward the correlation id + resolved pathname onto the REQUEST so route
  // handlers / RSC / server code (lib/api/respond.ts, requireOrgContext) can
  // read them. A fresh Headers copy is the documented way to mutate forwarded
  // request headers from middleware.
  const requestHeaders = new Headers(request.headers);
  if (requestId) requestHeaders.set(REQUEST_ID_HEADER, requestId);
  requestHeaders.set(PATHNAME_HEADER, request.nextUrl.pathname);
  const nextInit = { request: { headers: requestHeaders } };

  // Stamp the correlation id on any response we hand back (passthrough OR
  // redirect) so the client + logs always see it.
  const stamp = <T extends NextResponse>(res: T): T => {
    if (requestId) res.headers.set(REQUEST_ID_HEADER, requestId);
    return res;
  };

  let supabaseResponse = NextResponse.next(nextInit);

  const supabase = createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        supabaseResponse = NextResponse.next(nextInit);
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  // IMPORTANT: getUser() makes a network call to validate the JWT.
  // Don't switch to getSession() — that returns stale data.
  //
  // This network call runs on EVERY matched request. If it threw (network
  // blip / cold start) or came back as a 5xx from GoTrue, the middleware
  // used to crash and Vercel surfaced the request as a 5xx (503) — which
  // intermittently broke unrelated write POSTs (record payment, assign
  // shift, payroll draft) AND the post-write router.refresh() RSC fetch
  // (e.g. "Shift added" shown but the grid never updated).
  //
  // We now fail SAFE: a transient auth error lets the request through
  // instead of 503-ing it. This is not a security regression — every
  // protected page/server action re-validates auth server-side via
  // requireUser()/requireOrgContext(), which remains the real gate. We
  // only suppress the middleware-level redirect when auth is genuinely
  // unreachable (so a logged-in user isn't bounced to /login on a blip);
  // a clean "no user" (expired/absent session, status < 500) still
  // redirects exactly as before.
  let user: User | null = null;
  let authUnavailable = false;
  try {
    const { data, error } = await supabase.auth.getUser();
    user = data.user;
    const status = (error as { status?: number } | null)?.status;
    if (!user && typeof status === "number" && status >= 500) {
      authUnavailable = true;
      console.error(
        "[middleware] auth.getUser returned a server error — passing request through",
        { status, pathname: request.nextUrl.pathname },
      );
    }
  } catch (e) {
    authUnavailable = true;
    console.error(
      "[middleware] auth.getUser threw — passing request through",
      e,
    );
  }

  const { pathname } = request.nextUrl;

  // Routes that are public regardless of auth state.
  const isPublicRoute =
    pathname === "/" ||
    pathname.startsWith("/pricing") ||
    // Public SEO / marketing surface — see app/(marketing) + app/robots.ts.
    // These MUST stay public so visitors and crawlers reach them, not /login.
    pathname.startsWith("/features") ||
    pathname.startsWith("/compare") ||
    pathname.startsWith("/industries") ||
    pathname.startsWith("/construction-software") ||
    pathname.startsWith("/tools") ||
    pathname.startsWith("/blog") ||
    pathname.startsWith("/for/") ||
    pathname.startsWith("/privacy") ||
    pathname.startsWith("/terms") ||
    pathname.startsWith("/q/") || // public per-quote view
    pathname.startsWith("/customer-portal/") || // customer-scoped portal
    pathname.startsWith("/payment/") || // Stripe Checkout success/cancel return (customer not yet logged in)
    pathname.startsWith("/auth/callback") ||
    pathname === "/api/health" ||
    pathname === "/api/waitlist" ||
    pathname === "/api/demo";

  // Auth-flow pages (login / signup / check-email / reset-password).
  //
  // /reset-password is the "forgot password" request page — a LOGGED-OUT user
  // must be able to reach it, so it belongs here (an authed visitor is bounced
  // to their dashboard, which is fine — they'd change a password in-app).
  //
  // Deliberately NOT listed here (must stay reachable by an AUTHENTICATED
  // session, so they must not be treated as auth-flow and bounced away):
  //   - /login/mfa       → the aal1 session finishing its TOTP challenge.
  //   - /update-password → the recovery session (or a signed-in user) setting
  //                        a new password. Both hold a live session by design.
  const isAuthFlow =
    pathname === "/login" ||
    pathname === "/signup" ||
    pathname === "/reset-password" ||
    pathname.startsWith("/check-email");

  // Build a redirect response that preserves any session cookies Supabase
  // wrote during getUser(). Without this, a refreshed JWT cookie that landed
  // on `supabaseResponse` would be lost the moment we returned a brand-new
  // NextResponse.redirect — causing auth loops and stale sessions.
  const redirectTo = (url: URL) => {
    const response = NextResponse.redirect(url);
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie);
    });
    return stamp(response);
  };

  // Logged in but visiting auth pages → send them in. Super-admins land
  // on the HQ panel by default; everyone else on their workspace
  // dashboard. We read the allowlist directly here (env), not via the
  // helper, so the middleware stays free of server-only imports.
  if (user && isAuthFlow) {
    const allowlist = (process.env.CREWFLOW_SUPERADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const isSuperAdmin =
      !!user.email && allowlist.includes(user.email.trim().toLowerCase());
    return redirectTo(
      new URL(isSuperAdmin ? "/admin/organizations" : "/dashboard", request.url),
    );
  }

  // Logged out and visiting anything else → send them to login.
  //
  // The !authUnavailable guard is the load-bearing half of the fail-safe:
  // when auth was genuinely unreachable we DON'T bounce to /login (the
  // user may well be logged in; the page/server action re-validates and
  // gates properly). A clean "no user" still redirects exactly as before.
  if (!user && !authUnavailable && !isPublicRoute && !isAuthFlow) {
    const url = new URL("/login", request.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return redirectTo(url);
  }

  return stamp(supabaseResponse);
}
