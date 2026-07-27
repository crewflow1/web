import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";

/**
 * Dev/preview-only sign-in shortcut.
 *
 *   GET /api/dev/test-login?token=<DEV_TEST_LOGIN_TOKEN>
 *
 * Generates a magic link for the configured test user via the admin
 * client, then redirects the caller to that link. Supabase's verify
 * endpoint then sets the auth cookies and lands the user on /dashboard
 * — same flow as a real magic-link click, just without the email round
 * trip.
 *
 * Hard refusals (defence in depth):
 *   1. VERCEL_ENV === 'production' → 404, full stop
 *   2. DEV_TEST_LOGIN_TOKEN env var unset → 503
 *   3. Submitted token doesn't match env var → 401
 *
 * The route file lives under /api/dev/* so its purpose is explicit. The
 * middleware does NOT exempt it; that's intentional — anonymous users
 * hit it just like the public auth callback.
 */

export async function GET(request: NextRequest) {
  // Environment lockout — FAIL CLOSED. Enable only on an affirmative non-prod
  // signal (Vercel preview/development, or a local `next dev` run). Any other
  // environment — production, an unknown/unset VERCEL_ENV, or a non-Vercel host
  // — is a hard 404. A deny-list ("block if == 'production'") would leave this
  // route open wherever VERCEL_ENV isn't set; an allow-list closes that gap.
  const vercelEnv = process.env.VERCEL_ENV;
  const isPreviewOrDev = vercelEnv === "preview" || vercelEnv === "development";
  const isLocalDev = process.env.NODE_ENV === "development"; // only under `next dev`
  if (!isPreviewOrDev && !isLocalDev) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const token = env.DEV_TEST_LOGIN_TOKEN;
  const email = env.DEV_TEST_USER_EMAIL;
  if (!token || !email) {
    return NextResponse.json(
      {
        error: "test_login_disabled",
        detail:
          "Set DEV_TEST_LOGIN_TOKEN and DEV_TEST_USER_EMAIL in the Vercel Preview environment (NOT Production) to enable this route.",
      },
      { status: 503 },
    );
  }

  const url = request.nextUrl;
  const providedToken = url.searchParams.get("token") ?? "";
  if (providedToken !== token) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // Use the admin API to generate a magic-link for the test user. The
  // returned `action_link` is what a real user would click in their
  // inbox; redirecting to it sets the session cookies.
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: {
      redirectTo: `${env.NEXT_PUBLIC_APP_URL}/dashboard`,
    },
  });

  if (error || !data?.properties?.action_link) {
    console.error("[dev/test-login] generateLink failed", error);
    return NextResponse.json(
      {
        error: "magic_link_failed",
        detail:
          "Generate-link call returned no action_link. Confirm DEV_TEST_USER_EMAIL exists in auth.users for this project.",
      },
      { status: 500 },
    );
  }

  return NextResponse.redirect(data.properties.action_link);
}
