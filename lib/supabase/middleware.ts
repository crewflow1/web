import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "./types";

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
export async function updateSession(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  }
  if (!supabaseAnonKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient<Database>(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: CookieToSet[]) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  // IMPORTANT: getUser() makes a network call to validate the JWT.
  // Don't switch to getSession() — that returns stale data.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // Routes that are public regardless of auth state.
  const isPublicRoute =
    pathname === "/" ||
    pathname.startsWith("/pricing") ||
    pathname.startsWith("/for/") ||
    pathname.startsWith("/privacy") ||
    pathname.startsWith("/terms") ||
    pathname.startsWith("/q/") || // public per-quote view
    pathname.startsWith("/customer-portal/") || // customer-scoped portal
    pathname.startsWith("/auth/callback") ||
    pathname === "/api/health" ||
    pathname === "/api/waitlist";

  // Auth-flow pages (login / signup / check-email).
  const isAuthFlow =
    pathname === "/login" ||
    pathname === "/signup" ||
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
    return response;
  };

  // Logged in but visiting auth pages → send them in.
  if (user && isAuthFlow) {
    return redirectTo(new URL("/dashboard", request.url));
  }

  // Logged out and visiting anything else → send them to login.
  if (!user && !isPublicRoute && !isAuthFlow) {
    const url = new URL("/login", request.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return redirectTo(url);
  }

  return supabaseResponse;
}
