import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

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
 * (app) and (onboarding) layouts instead of here — that keeps middleware
 * fast and avoids a DB query on every public-page request.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

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
    pathname.startsWith("/q/") || // public quote accept (Block 4)
    pathname.startsWith("/auth/callback") ||
    pathname === "/api/health";

  // Auth-flow pages (login / signup / check-email).
  const isAuthFlow =
    pathname === "/login" ||
    pathname === "/signup" ||
    pathname.startsWith("/check-email");

  // Logged in but visiting auth pages → send them in.
  if (user && isAuthFlow) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  // Logged out and visiting anything else → send them to login.
  if (!user && !isPublicRoute && !isAuthFlow) {
    const url = new URL("/login", request.url);
    if (pathname !== "/") url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
