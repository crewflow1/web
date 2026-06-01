import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ensureUserRow } from "@/server/services/bootstrap-account";
import { isSuperAdminEmail } from "@/server/auth/superadmin";

/**
 * OAuth + magic-link callback.
 *
 * Handles THREE arrival shapes:
 *
 *   1. `?code=...` (OAuth + PKCE-style sign-in from the /login form)
 *      → exchangeCodeForSession (needs a `code_verifier` cookie set in
 *        the same browser that initiated the request).
 *
 *   2. `?token_hash=...&type=...` (magiclink/invite/email/recovery
 *      links generated server-side via admin.generateLink, embedded
 *      in our branded Resend emails)
 *      → verifyOtp — works regardless of PKCE state, so the link is
 *        clickable from any browser/device the customer happens to
 *        open the email in.
 *
 *   3. `?error=...&error_description=...` (Supabase redirected us
 *      back with an explicit error — usually expired or already-used
 *      token).
 *
 * Default landing after successful exchange:
 *   - super-admin email → /admin/organizations (CrewFlow HQ)
 *   - everyone else     → /dashboard (which itself routes to
 *                         /onboarding/company when no org context).
 * Explicit `?next=...` deep links survive for non-super-admins.
 *
 * On any failure we redirect to /login with:
 *   - `?error=<reason>` so the page surfaces a useful message
 *   - `?email=<user-email>` when we know it, so the form can pre-fill
 *     and the user is one click away from a fresh magic link.
 *
 * Every failure path is logged with structured context so we can
 * triage from production logs without guessing.
 */

type ErrCode =
  | "missing_code"
  | "auth_failed"
  | "bootstrap_failed"
  | "magic_link_used"
  | "magic_link_expired"
  | "magic_link_invalid"
  | "provider_error";

function logErr(reason: ErrCode, info: Record<string, unknown> = {}) {
  console.error(
    JSON.stringify({
      event: "auth.callback.error",
      reason,
      ...info,
    }),
  );
}

function classifySupabaseError(msg: string | null | undefined): ErrCode {
  const m = (msg ?? "").toLowerCase();
  if (m.includes("already") || m.includes("used")) return "magic_link_used";
  if (m.includes("expire")) return "magic_link_expired";
  if (m.includes("invalid")) return "magic_link_invalid";
  if (m) return "auth_failed";
  return "auth_failed";
}

function bounceToLogin(
  origin: string,
  reason: ErrCode,
  emailHint: string | null,
): NextResponse {
  const u = new URL(`${origin}/login`);
  u.searchParams.set("error", reason);
  if (emailHint) u.searchParams.set("email", emailHint);
  return NextResponse.redirect(u);
}

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const explicitNext = searchParams.get("next");
  const supabaseErr = searchParams.get("error");
  const supabaseErrDesc = searchParams.get("error_description");

  // Supabase bounced us back with an explicit error (e.g. expired token,
  // redirect_to not on the allowlist). Surface a useful message rather
  // than the generic "auth_failed".
  if (supabaseErr) {
    const reason = classifySupabaseError(supabaseErrDesc ?? supabaseErr);
    logErr(reason, {
      supabase_error: supabaseErr,
      supabase_error_description: supabaseErrDesc,
    });
    return bounceToLogin(origin, reason, null);
  }

  if (!code && !tokenHash) {
    logErr("missing_code", { url: request.url });
    return bounceToLogin(origin, "missing_code", null);
  }

  const supabase = await createClient();

  // ----- Path A: token_hash + type (magic link sent via our own email) ---
  let userPayload: { id: string; email: string | null; user_metadata: Record<string, unknown> } | null = null;
  if (tokenHash && type) {
    const validTypes = new Set([
      "magiclink",
      "invite",
      "email",
      "recovery",
      "email_change",
      "signup",
    ]);
    if (!validTypes.has(type)) {
      logErr("magic_link_invalid", { type });
      return bounceToLogin(origin, "magic_link_invalid", null);
    }
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type as "magiclink" | "invite" | "email" | "recovery",
    });
    if (error || !data.user) {
      const reason = classifySupabaseError(error?.message);
      logErr(reason, {
        flow: "verifyOtp",
        type,
        supabase_message: error?.message,
        supabase_status: error?.status,
      });
      // We don't know the user's email here (Supabase rejected the
      // token before resolving it), so we can't pre-fill /login —
      // user types it in to request a fresh link.
      return bounceToLogin(origin, reason, null);
    }
    userPayload = {
      id: data.user.id,
      email: data.user.email ?? null,
      user_metadata: (data.user.user_metadata ?? {}) as Record<string, unknown>,
    };
  }

  // ----- Path B: code exchange (OAuth + PKCE login-form magic links) ----
  else if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data.user) {
      const reason = classifySupabaseError(error?.message);
      logErr(reason, {
        flow: "exchangeCodeForSession",
        supabase_message: error?.message,
        supabase_status: error?.status,
      });
      return bounceToLogin(origin, reason, null);
    }
    userPayload = {
      id: data.user.id,
      email: data.user.email ?? null,
      user_metadata: (data.user.user_metadata ?? {}) as Record<string, unknown>,
    };
  }

  if (!userPayload) {
    logErr("auth_failed", { reason: "no_user_payload" });
    return bounceToLogin(origin, "auth_failed", null);
  }

  // Pull display fields from OAuth provider metadata if present.
  const meta = userPayload.user_metadata;
  const fullName =
    (typeof meta.full_name === "string" && meta.full_name) ||
    (typeof meta.name === "string" && meta.name) ||
    (typeof meta.invited_full_name === "string" && meta.invited_full_name) ||
    null;
  const avatarUrl =
    (typeof meta.avatar_url === "string" && meta.avatar_url) ||
    (typeof meta.picture === "string" && meta.picture) ||
    null;
  const phone =
    (typeof meta.phone === "string" && meta.phone) ||
    (typeof meta.invited_phone === "string" && meta.invited_phone) ||
    null;

  try {
    await ensureUserRow({
      id: userPayload.id,
      email: userPayload.email ?? "",
      fullName,
      avatarUrl,
      phone,
    });
  } catch (e) {
    logErr("bootstrap_failed", {
      user_id: userPayload.id,
      err: e instanceof Error ? e.message : String(e),
    });
    return bounceToLogin(origin, "bootstrap_failed", userPayload.email);
  }

  // Default landing per the 3-user-type auth model (source of truth):
  //   1. CrewFlow HQ admin (super-admin) -> HQ, ALWAYS. Never auto-lands in a
  //      customer workspace, even if they also belong to an org.
  //   2. Company owner / admin -> their company dashboard (/dashboard).
  //   3. Staff -> staff dashboard. /dashboard already redirects role=staff to
  //      /me, so non-admins resolve to the right place there.
  // Non-admins can never be deep-linked into /admin/*.
  const isAdmin = isSuperAdminEmail(userPayload.email);

  const safeExplicit =
    explicitNext && explicitNext.startsWith("/") && !explicitNext.startsWith("//")
      ? explicitNext
      : null;

  let safeNext: string;
  if (isAdmin) {
    // HQ admin: honour an explicit /admin/* deep link, otherwise the HQ
    // dashboard. Never a customer workspace.
    safeNext =
      safeExplicit && safeExplicit.startsWith("/admin") ? safeExplicit : "/admin";
  } else if (safeExplicit && !safeExplicit.startsWith("/admin")) {
    safeNext = safeExplicit;
  } else {
    // Owner -> /dashboard; staff -> /me (handled by /dashboard); brand-new
    // user with no org -> /onboarding/company (handled by requireOrgContext).
    safeNext = "/dashboard";
  }

  console.log(
    JSON.stringify({
      event: "auth.callback.success",
      user_id: userPayload.id,
      email: userPayload.email,
      is_super_admin: isAdmin,
      landing: safeNext,
    }),
  );
  return NextResponse.redirect(`${origin}${safeNext}`);
}
