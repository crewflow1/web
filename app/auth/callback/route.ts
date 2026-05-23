import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ensureUserRow } from "@/server/services/bootstrap-account";
import { isSuperAdminEmail } from "@/server/auth/superadmin";

/**
 * OAuth + magic-link callback.
 *
 * Receives `?code=...` from Supabase, exchanges it for a session, mirrors
 * the auth.users row into public.users, then redirects.
 *
 * Default landing:
 *   - super-admin email   → /admin/organizations (CrewFlow HQ)
 *   - everyone else       → /dashboard
 * Explicit `?next=...` always wins so deep links survive sign-in.
 *
 * Middleware handles the rest of the routing (no org → onboarding,
 * non-active org → access-pending — and access-pending itself bounces
 * super-admins to /admin so the lock screen can never trap them).
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const explicitNext = searchParams.get("next");

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.user) {
    console.error("[auth/callback] exchange failed", error);
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  // Pull display fields from OAuth provider metadata if present.
  // Google: { full_name, name, picture, avatar_url, email }
  // Magic link: usually just { email }
  const meta = (data.user.user_metadata ?? {}) as Record<string, unknown>;
  const fullName =
    (typeof meta.full_name === "string" && meta.full_name) ||
    (typeof meta.name === "string" && meta.name) ||
    null;
  const avatarUrl =
    (typeof meta.avatar_url === "string" && meta.avatar_url) ||
    (typeof meta.picture === "string" && meta.picture) ||
    null;

  try {
    await ensureUserRow({
      id: data.user.id,
      email: data.user.email ?? "",
      fullName,
      avatarUrl,
    });
  } catch (e) {
    console.error("[auth/callback] bootstrap failed", e);
    return NextResponse.redirect(`${origin}/login?error=bootstrap_failed`);
  }

  // Choose default landing based on role.
  //
  // For SUPER-ADMINS, the role-based fallback (/admin/organizations)
  // ALWAYS wins unless an explicit `?next=/admin/...` deep-link is
  // present. This is defence-in-depth — a stale magic-link, OAuth
  // re-bounce, or bookmarked URL with `?next=/dashboard` must never
  // route the CEO into a contractor workspace. (We hit this exact
  // bug once already.)
  //
  // For everyone else, the explicit `?next=` deep link wins so
  // contractors returning from a protected page land where they
  // expected to.
  const isAdmin = isSuperAdminEmail(data.user.email ?? null);
  const fallback = isAdmin ? "/admin/organizations" : "/dashboard";
  const safeExplicit =
    explicitNext && explicitNext.startsWith("/") && !explicitNext.startsWith("//")
      ? explicitNext
      : null;
  const safeNext = isAdmin
    ? safeExplicit && safeExplicit.startsWith("/admin")
      ? safeExplicit
      : fallback
    : (safeExplicit ?? fallback);
  return NextResponse.redirect(`${origin}${safeNext}`);
}
