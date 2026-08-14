"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { consume, DEFAULT_LIMITS } from "@/lib/security/rate-limit";
import { verifyRecoveryCode } from "@/lib/auth/recovery-codes";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { safeInternalPath } from "@/server/auth/safe-path";
import { ensureUserRow } from "@/server/services/bootstrap-account";

function getOrigin(headerList: Headers): string {
  const fromHeader = headerList.get("origin") ?? headerList.get("referer");
  if (fromHeader) {
    try {
      return new URL(fromHeader).origin;
    } catch {
      // fall through to env
    }
  }
  return env.NEXT_PUBLIC_APP_URL;
}

/**
 * Begin a Google OAuth flow.
 *
 * Returns a redirect to Google's consent screen. After the user accepts,
 * Google bounces back to Supabase, which bounces back to our /auth/callback.
 */
export async function signInWithGoogle() {
  const supabase = await createClient();
  const origin = getOrigin(await headers());

  // No hardcoded `?next=` — the auth callback already picks the
  // correct landing per role (super-admins → /admin/organizations,
  // everyone else → /dashboard). A hardcoded next pointing at the
  // contractor dashboard would override the super-admin fallback
  // and silently route the CEO into a tenant workspace.
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${origin}/auth/callback`,
      queryParams: {
        prompt: "select_account",
      },
    },
  });

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  if (data?.url) {
    redirect(data.url);
  }

  // Defensive: Supabase returned neither an error nor a URL. Don't leave the
  // form silently broken — surface it so the user can retry.
  redirect("/login?error=oauth_no_url");
}

const magicLinkSchema = z.object({
  email: z.string().email().max(254),
});

/**
 * Send a magic-link sign-in email.
 *
 * Supabase generates a one-time code, emails it to the user, and on click
 * redirects to /auth/callback?code=... which exchanges for a session.
 */
export async function signInWithMagicLink(formData: FormData) {
  const parsed = magicLinkSchema.safeParse({
    email: formData.get("email"),
  });

  if (!parsed.success) {
    redirect("/login?error=invalid_email");
  }

  // Throttle magic-link sends per destination address — blocks email-bomb /
  // Supabase cost abuse. Fails open (see lib/security/rate-limit) so a limiter
  // fault can never lock users out of sign-in.
  const limit = await consume(
    "auth",
    parsed.data.email.toLowerCase(),
    DEFAULT_LIMITS.auth,
  );
  if (!limit.allowed) {
    redirect(
      `/login?error=${encodeURIComponent("Too many sign-in attempts. Please wait a few minutes and try again.")}`,
    );
  }

  const supabase = await createClient();
  const origin = getOrigin(await headers());

  // No hardcoded `?next=` — see signInWithGoogle above.
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
      shouldCreateUser: true,
    },
  });

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  redirect(`/check-email?email=${encodeURIComponent(parsed.data.email)}`);
}

/**
 * Sign the user out, clear session cookies, and bounce to /login.
 */
export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

// ===========================================================================
// EMAIL + PASSWORD  (ADDITIVE — alongside magic-link + Google, never replacing)
// ===========================================================================
//
// CONFIG NOTE (activation, not code): email+password sign-in relies on the
// Supabase "Email" auth provider having the PASSWORD grant enabled in the
// dashboard (Authentication → Providers → Email). Magic-link (OTP) uses the
// same provider, so it is almost certainly already on — but if signInWithPassword
// returns "Email logins are disabled" it is that toggle, NOT this code. The UI
// below is built so it works the moment the grant is on. Nothing here changes
// the existing signInWithOtp / signInWithOAuth flows.
//
// A magic-link / Google user simply has no password set: signInWithPassword
// returns "Invalid login credentials" for them, which we surface plainly. Their
// passwordless sign-in keeps working exactly as before.

// Supabase hashes with bcrypt, which silently truncates beyond 72 bytes — cap
// the input so "the first 72 chars" can never become a confusing auth mismatch.
const PASSWORD_MAX = 72;
const PASSWORD_MIN = 8;

const passwordSignInSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(254),
  password: z.string().min(1, "Enter your password").max(PASSWORD_MAX),
  // Optional post-login landing, carried from ?next= on /login. Validated
  // below (must be a local path) before it is ever used as a redirect target.
  next: z.string().optional(),
});

const passwordSignUpSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(254),
  password: z
    .string()
    .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`)
    .max(PASSWORD_MAX, `Use at most ${PASSWORD_MAX} characters`),
  confirm: z.string().min(1, "Re-enter your password"),
}).refine((v) => v.password === v.confirm, {
  message: "Passwords don't match",
  path: ["confirm"],
});

/**
 * Compute a safe post-login landing, mirroring app/auth/callback/route.ts:
 *   - super-admin  → /admin/organizations (never a tenant workspace)
 *   - explicit safe /next (local, non-/admin) → honoured
 *   - otherwise     → /dashboard
 */
function safeLanding(email: string | null, rawNext: string | undefined): string {
  const isAdmin = isSuperAdminEmail(email);
  const safeExplicit = safeInternalPath(rawNext);
  if (isAdmin) {
    return safeExplicit && safeExplicit.startsWith("/admin")
      ? safeExplicit
      : "/admin/organizations";
  }
  if (safeExplicit && !safeExplicit.startsWith("/admin")) return safeExplicit;
  return "/dashboard";
}

/**
 * Email + password sign-in.
 *
 * Returns a FormState (useActionState) so the /login form can render inline
 * errors and preserve the typed email — no redirect round-trip that would
 * wipe the field. On success `redirectTo` names the landing; the client
 * navigates there.
 *
 * If the user has a VERIFIED TOTP factor, a session is created at aal1 and we
 * redirect to /login/mfa to finish the challenge (→ aal2). We do NOT hard-block
 * aal1 sessions elsewhere — MFA is opt-in (see the enforcement note in
 * app/(app)/settings/security/actions.ts).
 */
export async function signInWithPassword(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = validateFormData(formData, passwordSignInSchema);
  if (!result.ok) {
    // Never echo the password back into the form values.
    const s = result.state;
    if (s.values) delete (s.values as Record<string, unknown>).password;
    return s;
  }
  const { email, password, next } = result.data;

  // Same limiter as magic-link — throttles credential-stuffing per address.
  // Fails OPEN (see lib/security/rate-limit) so a limiter fault never locks
  // anyone out of sign-in.
  const limit = await consume("auth", email, DEFAULT_LIMITS.auth);
  if (!limit.allowed) {
    return formError(
      "Too many sign-in attempts. Please wait a few minutes and try again.",
      { email },
    );
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error || !data.user) {
    // Loud but non-enumerating: identical message whether the email is unknown
    // or the password is wrong. A magic-link/Google user (no password) also
    // lands here — the hint points them back to the passwordless options.
    return formError(
      "Incorrect email or password. If you normally sign in with Google or a magic link, use those options above.",
      { email },
    );
  }

  // Defensive bootstrap parity with the OAuth/magic-link callback so a
  // password sign-in never lands on a page that expects a public.users row.
  try {
    await ensureUserRow({ id: data.user.id, email: data.user.email ?? email });
  } catch {
    // Non-fatal: requireOrgContext will route brand-new users to onboarding.
  }

  // MFA gate: a verified factor leaves the fresh session at aal1 with a
  // pending aal2. Finish the challenge before landing.
  const { data: aal } =
    await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal && aal.nextLevel === "aal2" && aal.nextLevel !== aal.currentLevel) {
    return formSuccess({ redirectTo: `/login/mfa${next ? `?next=${encodeURIComponent(next)}` : ""}` });
  }

  return formSuccess({ redirectTo: safeLanding(data.user.email ?? email, next) });
}

/**
 * Email + password sign-up.
 *
 * Uses supabase.auth.signUp. If the project requires email confirmation
 * (Supabase setting), no session is returned and we tell the user to confirm
 * via the emailed link (it lands on /auth/callback like every other link). If
 * confirmation is off, a session is returned and we bootstrap + land them.
 */
export async function signUpWithPassword(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = validateFormData(formData, passwordSignUpSchema);
  if (!result.ok) {
    const s = result.state;
    if (s.values) {
      delete (s.values as Record<string, unknown>).password;
      delete (s.values as Record<string, unknown>).confirm;
    }
    return s;
  }
  const { email, password } = result.data;

  const limit = await consume("auth", email, DEFAULT_LIMITS.auth);
  if (!limit.allowed) {
    return formError(
      "Too many attempts. Please wait a few minutes and try again.",
      { email },
    );
  }

  const supabase = await createClient();
  const origin = getOrigin(await headers());

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${origin}/auth/callback` },
  });

  if (error) {
    // NEUTRAL, non-enumerating: Supabase's raw error.message leaks account
    // existence ("User already registered") for a known email. Return an
    // identical message regardless of the underlying cause so signup cannot be
    // used to probe which emails have accounts.
    return formError(
      "Could not create the account. If you already have one, sign in instead.",
      { email },
    );
  }

  // No session ⇒ email confirmation is required. Don't pretend they're in.
  if (!data.session) {
    return formSuccess({
      successMessage:
        "Account created. Check your email for a confirmation link to finish signing in.",
      values: { email },
    });
  }

  // Confirmation disabled ⇒ signed in immediately. Bootstrap + land.
  if (data.user) {
    try {
      await ensureUserRow({ id: data.user.id, email: data.user.email ?? email });
    } catch {
      // Non-fatal — onboarding will pick them up.
    }
  }
  return formSuccess({ redirectTo: safeLanding(data.user?.email ?? email, undefined) });
}

// ===========================================================================
// PASSWORD RESET / RECOVERY
// ===========================================================================

const resetRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(254),
});

/**
 * Request a password-reset email. Supabase emails a recovery link that lands
 * on /auth/callback (type=recovery), which verifies the token, creates a
 * session, and forwards to /update-password (via ?next=).
 *
 * Always returns the SAME success state whether or not the address exists —
 * never leak account existence.
 */
export async function requestPasswordReset(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = validateFormData(formData, resetRequestSchema);
  if (!result.ok) return result.state;
  const { email } = result.data;

  const limit = await consume("auth", email, DEFAULT_LIMITS.auth);
  // Even when throttled we return the neutral success message — no enumeration,
  // no lockout signal.
  if (limit.allowed) {
    const supabase = await createClient();
    const origin = getOrigin(await headers());
    await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${origin}/auth/callback?next=/update-password`,
    });
  }

  return formSuccess({
    successMessage:
      "If an account exists for that email, we've sent a link to reset your password. It can take a minute to arrive and may land in spam.",
    values: { email },
  });
}

const updatePasswordSchema = z.object({
  password: z
    .string()
    .min(PASSWORD_MIN, `Use at least ${PASSWORD_MIN} characters`)
    .max(PASSWORD_MAX, `Use at most ${PASSWORD_MAX} characters`),
  confirm: z.string().min(1, "Re-enter your password"),
}).refine((v) => v.password === v.confirm, {
  message: "Passwords don't match",
  path: ["confirm"],
});

/**
 * Set a new password for the CURRENTLY authenticated session.
 *
 * Reached two ways, both requiring a live session (so this can never set a
 * stranger's password):
 *   1. from the recovery link (callback established a recovery session), or
 *   2. a signed-in user changing their password in-app.
 *
 * If there is no session we refuse loudly rather than silently no-op.
 */
export async function updatePassword(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = validateFormData(formData, updatePasswordSchema);
  if (!result.ok) {
    const s = result.state;
    if (s.values) {
      delete (s.values as Record<string, unknown>).password;
      delete (s.values as Record<string, unknown>).confirm;
    }
    return s;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return formError(
      "Your reset link has expired or you're signed out. Request a new reset email and try again.",
    );
  }

  const { error } = await supabase.auth.updateUser({ password: result.data.password });
  if (error) {
    return formError(error.message);
  }

  return formSuccess({
    successMessage: "Password updated. You can use it to sign in from now on.",
    redirectTo: safeLanding(user.email ?? null, undefined),
  });
}

// ===========================================================================
// MICROSOFT SSO  (DARK — credential-gated; provider 'azure')
// ===========================================================================

/**
 * Begin a Microsoft (Azure AD) OAuth flow. Mirrors signInWithGoogle.
 *
 * DARK by default: the "Continue with Microsoft" button only renders when
 * NEXT_PUBLIC_FEATURE_MICROSOFT_SSO === "true", which should be flipped ONLY
 * once the EXTERNAL credential exists (a Supabase Azure provider backed by an
 * Azure AD app registration). Without that, Supabase returns a provider error
 * — this action surfaces it plainly rather than failing silently.
 */
export async function signInWithMicrosoft() {
  const supabase = await createClient();
  const origin = getOrigin(await headers());

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "azure",
    options: {
      redirectTo: `${origin}/auth/callback`,
      scopes: "email openid profile",
    },
  });

  if (error) {
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }
  if (data?.url) {
    redirect(data.url);
  }
  redirect("/login?error=oauth_no_url");
}

// ===========================================================================
// MFA (TOTP) LOGIN CHALLENGE  (opt-in; upgrades an aal1 session to aal2)
// ===========================================================================

const mfaChallengeSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your app"),
  next: z.string().optional(),
});

/**
 * Complete the TOTP challenge at login. Requires a live (aal1) session — the
 * password step already created one. Finds the user's verified TOTP factor,
 * challenges it, and verifies the code to reach aal2.
 *
 * NOTE: this is the OPT-IN completion of MFA for users who enrolled. It is
 * NOT a global gate — users without a factor never reach here, and an aal1
 * session is not forcibly blocked elsewhere.
 */
export async function challengeMfa(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = validateFormData(formData, mfaChallengeSchema);
  if (!result.ok) return result.state;
  const { code, next } = result.data;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return formError("Your session expired. Please sign in again.");
  }

  const { data: factors, error: listErr } = await supabase.auth.mfa.listFactors();
  if (listErr) {
    return formError("We couldn't load your authentication factors. Try again.");
  }
  const totp = (factors?.totp ?? []).find((f) => f.status === "verified");
  if (!totp) {
    // No verified factor — nothing to challenge. Let them straight in rather
    // than trapping them on this page.
    return formSuccess({ redirectTo: safeLanding(user.email ?? null, next) });
  }

  const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({
    factorId: totp.id,
  });
  if (chErr || !challenge) {
    return formError("We couldn't start the verification. Try again.");
  }

  const { error: verifyErr } = await supabase.auth.mfa.verify({
    factorId: totp.id,
    challengeId: challenge.id,
    code,
  });
  if (verifyErr) {
    return formError("That code didn't match. Check your authenticator app and try again.");
  }

  return formSuccess({ redirectTo: safeLanding(user.email ?? null, next) });
}

// ===========================================================================
// MFA RECOVERY CODE  (lost-device escape hatch at the login challenge)
// ===========================================================================

const recoveryCodeSchema = z.object({
  // Accept the code in any casing / with-or-without the display dash & spaces;
  // normalisation happens inside verifyRecoveryCode. 8–32 chars covers the
  // formatted (11) and bare (10) forms with slack.
  code: z
    .string()
    .trim()
    .min(8, "Enter one of your recovery codes")
    .max(32, "That doesn't look like a recovery code"),
  next: z.string().optional(),
});

/**
 * Redeem an MFA recovery (backup) code at the login challenge.
 *
 * This is the escape hatch for a user who enrolled TOTP and lost the device:
 * with a live aal1 session (created by the password step) they present a backup
 * code instead of an authenticator code. On a match we:
 *   1. mark that single code used (one-time — a redeemed code never works again),
 *   2. remove the user's TOTP factor(s) via the admin API, and
 *   3. delete their remaining recovery codes (the set is spent once used to
 *      recover — they'll be prompted to re-enrol and mint a fresh batch).
 *
 * Removing the lost factor is what actually lets them back in: with no verified
 * factor, the aal1 session is sufficient (MFA is opt-in / not force-gated). This
 * mirrors the existing self-service recovery ("remove the factor") but works
 * WITHOUT a second working sign-in method — the whole point of backup codes.
 *
 * Security posture: rate-limited (shares the auth limiter, keyed by user id),
 * constant-time hash comparison, non-enumerating error, and all secret-table
 * access via the service-role client scoped to this user's id. Never logs a code.
 */
export async function redeemRecoveryCode(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = validateFormData(formData, recoveryCodeSchema);
  if (!result.ok) return result.state;
  const { code, next } = result.data;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return formError("Your session expired. Please sign in again.");
  }

  // Throttle guessing — same limiter as the rest of auth, keyed by the user id
  // (a code is ~50 bits so this is defence-in-depth, not the primary barrier).
  // Fails OPEN (see lib/security/rate-limit) so a limiter fault never strands a
  // locked-out user.
  const limit = await consume("auth", user.id, DEFAULT_LIMITS.auth);
  if (!limit.allowed) {
    return formError("Too many attempts. Please wait a few minutes and try again.");
  }

  const admin = createAdminClient();
  const { data: rows, error: readErr } = await admin
    .from("mfa_recovery_codes")
    .select("id, code_hash")
    .eq("user_id", user.id)
    .is("used_at", null);
  if (readErr) {
    return formError("We couldn't verify that code just now. Try again.");
  }

  const match = (rows ?? []).find((r) => verifyRecoveryCode(code, r.code_hash));
  if (!match) {
    return formError("That recovery code isn't valid. Check it and try again.");
  }

  // Consume the used code (one-time). If this write fails, refuse rather than
  // proceed — a code that couldn't be burned must not grant access.
  const { error: burnErr } = await admin
    .from("mfa_recovery_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("id", match.id)
    .is("used_at", null);
  if (burnErr) {
    return formError("We couldn't complete recovery just now. Try again.");
  }

  // Remove the lost factor(s) so the aal1 session is sufficient to get back in.
  const { data: factors } = await supabase.auth.mfa.listFactors();
  for (const f of factors?.totp ?? []) {
    try {
      await admin.auth.admin.mfa.deleteFactor({ id: f.id, userId: user.id });
    } catch {
      // best-effort per factor; a residual factor just means another challenge,
      // and the user has already burned a code — don't hard-fail the recovery.
    }
  }

  // The set is spent — clear the rest so a stale batch can't linger.
  await admin.from("mfa_recovery_codes").delete().eq("user_id", user.id);

  return formSuccess({ redirectTo: safeLanding(user.email ?? null, next) });
}
