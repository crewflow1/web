"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { env } from "@/lib/env";
import { generateRecoveryCodes as mintRecoveryCodes } from "@/lib/auth/recovery-codes";
import {
  type FormState,
  formError,
  formSuccess,
  validateFormData,
} from "@/lib/forms/state";

/**
 * Account-security server actions (ADDITIVE, opt-in).
 *
 *   - TOTP MFA enrolment / verification / unenrolment (self-service).
 *   - OAuth identity linking (config-gated behind manual linking).
 *
 * =====================================================================
 * MFA ENFORCEMENT IS A GATED, OPT-IN DECISION (now implemented, default OFF).
 * Enrolment here is OPT-IN and per-user. Enforcement is OPT-IN per ORG via the
 * `organizations.require_mfa` flag (migration 20261169000000): while it is off
 * — the default for every org — nothing changes and this enrolment stays purely
 * voluntary. When an org turns it ON, the gate lives in server/auth/session.ts
 * (requireOrgContext), driven by the pure, fail-closed decision in
 * lib/auth/mfa-policy.ts — NOT here — and applies ONLY to privileged roles
 * (owner/admin), redirecting them to complete or first enrol TOTP. Global,
 * all-user enforcement is deliberately NOT done (it would instantly lock out
 * every existing magic-link / Google user who has no factor).
 * =====================================================================
 */

function getOrigin(headerList: Headers): string {
  const fromHeader = headerList.get("origin") ?? headerList.get("referer");
  if (fromHeader) {
    try {
      return new URL(fromHeader).origin;
    } catch {
      // fall through
    }
  }
  return env.NEXT_PUBLIC_APP_URL;
}

export type EnrollResult =
  | { ok: true; factorId: string; qrCode: string; secret: string }
  | { ok: false; error: string };

/**
 * Begin TOTP enrolment. Returns the QR code (SVG data URI) + manual secret and
 * the new factor id, which the client shows and then passes back to
 * verifyTotpEnrollment. The factor stays UNVERIFIED (and therefore does NOT
 * gate sign-in) until the user proves possession with a valid code.
 */
export async function enrollTotp(): Promise<EnrollResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "You're signed out. Sign in and try again." };

  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: `authenticator-${Date.now()}`,
  });
  if (error || !data) {
    return { ok: false, error: error?.message ?? "Couldn't start enrolment. Try again." };
  }
  return {
    ok: true,
    factorId: data.id,
    qrCode: data.totp.qr_code,
    secret: data.totp.secret,
  };
}

const verifySchema = z.object({
  factorId: z.string().min(1),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code from your app"),
});

/**
 * Verify a pending TOTP enrolment. Challenges the factor and verifies the code;
 * on success the factor becomes verified and future sign-ins will offer the
 * challenge step.
 */
export async function verifyTotpEnrollment(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = validateFormData(formData, verifySchema);
  if (!result.ok) return result.state;
  const { factorId, code } = result.data;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return formError("You're signed out. Sign in and try again.");

  const { data: challenge, error: chErr } = await supabase.auth.mfa.challenge({
    factorId,
  });
  if (chErr || !challenge) {
    return formError("Couldn't start verification. Try again.");
  }

  const { error: verifyErr } = await supabase.auth.mfa.verify({
    factorId,
    challengeId: challenge.id,
    code,
  });
  if (verifyErr) {
    return formError("That code didn't match. Check your authenticator app and try again.");
  }

  return formSuccess({
    successMessage: "Two-factor authentication is on. You'll be asked for a code at sign-in.",
  });
}

export type RecoveryCodesResult =
  | { ok: true; codes: string[] }
  | { ok: false; error: string };

/**
 * Generate (or regenerate) the signed-in user's MFA recovery codes.
 *
 * Recovery codes are the escape hatch for a lost authenticator — see
 * lib/auth/recovery-codes.ts and app/(auth)/actions.ts#redeemRecoveryCode. This
 * is a REPLACE operation: any previously issued codes for the user are deleted
 * and a fresh batch minted, so a user who regenerates immediately invalidates
 * an old (possibly leaked or half-used) set.
 *
 * The plaintext codes are returned ONCE for display; only their scrypt hashes
 * are stored. Writes go through the service-role client (RLS makes the table
 * unreachable to the authenticated role) scoped explicitly to this user's id.
 *
 * Gated on having a verified TOTP factor: recovery codes only mean anything
 * once MFA is actually on, and offering them otherwise would mislead.
 */
export async function generateRecoveryCodes(): Promise<RecoveryCodesResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "You're signed out. Sign in and try again." };

  const { data: factors, error: listErr } = await supabase.auth.mfa.listFactors();
  if (listErr) {
    return { ok: false, error: "Couldn't check your authenticators. Try again." };
  }
  const hasVerified = (factors?.totp ?? []).some((f) => f.status === "verified");
  if (!hasVerified) {
    return {
      ok: false,
      error: "Set up an authenticator app first — recovery codes back it up.",
    };
  }

  const { display, hashes } = mintRecoveryCodes();

  const admin = createAdminClient();
  // Replace the whole set atomically enough for this path: delete old, insert
  // new. Both are scoped to THIS user's id — never a blanket table op.
  const { error: delErr } = await admin
    .from("mfa_recovery_codes")
    .delete()
    .eq("user_id", user.id);
  if (delErr) {
    return { ok: false, error: "Couldn't refresh your recovery codes. Try again." };
  }

  const { error: insErr } = await admin.from("mfa_recovery_codes").insert(
    hashes.map((code_hash) => ({ user_id: user.id, code_hash })),
  );
  if (insErr) {
    return { ok: false, error: "Couldn't save your recovery codes. Try again." };
  }

  return { ok: true, codes: display };
}

const unenrollSchema = z.object({ factorId: z.string().min(1) });

/**
 * Remove an enrolled factor (verified or pending). Self-service recovery: a
 * user who loses their authenticator can still sign in with a magic link /
 * Google / password and remove the factor here.
 */
export async function unenrollFactor(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const result = validateFormData(formData, unenrollSchema);
  if (!result.ok) return result.state;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return formError("You're signed out. Sign in and try again.");

  const { error } = await supabase.auth.mfa.unenroll({ factorId: result.data.factorId });
  if (error) return formError(error.message);

  // Purge recovery codes once no verified factor remains — stale backup codes
  // for a user with no MFA are dead weight. Best-effort: a cleanup blip must
  // never fail the (already successful) unenrol. We bind the factors-read error
  // and only purge when we've POSITIVELY confirmed no protection remains — on a
  // read error we leave the (inert, hashed) codes untouched rather than guess.
  try {
    const { data: factors, error: listErr } = await supabase.auth.mfa.listFactors();
    const stillProtected = (factors?.totp ?? []).some((f) => f.status === "verified");
    if (!listErr && !stillProtected) {
      const admin = createAdminClient();
      await admin.from("mfa_recovery_codes").delete().eq("user_id", user.id);
    }
  } catch {
    // non-fatal — the factor is gone; leftover hashed codes are inert.
  }

  return formSuccess({ successMessage: "Authenticator removed." });
}

/**
 * Link an additional OAuth identity (Google / Microsoft) to the signed-in
 * account. CONFIG-GATED: Supabase "Manual Linking" must be enabled in the
 * dashboard, and the button only renders when NEXT_PUBLIC_FEATURE_ACCOUNT_LINKING
 * === "true". Redirects to the provider's consent screen, returning via
 * /auth/callback like any other OAuth flow.
 */
async function linkIdentity(provider: "google" | "azure") {
  if (env.NEXT_PUBLIC_FEATURE_ACCOUNT_LINKING !== "true") {
    // Seam is dark — never dead-end at a broken provider call.
    redirect("/settings/security?error=linking_disabled");
  }
  const supabase = await createClient();
  const origin = getOrigin(await headers());
  const { data, error } = await supabase.auth.linkIdentity({
    provider,
    options: { redirectTo: `${origin}/auth/callback?next=/settings/security` },
  });
  if (error) {
    redirect(`/settings/security?error=${encodeURIComponent(error.message)}`);
  }
  if (data?.url) redirect(data.url);
  redirect("/settings/security?error=link_no_url");
}

export async function linkGoogleIdentity() {
  await linkIdentity("google");
}

export async function linkMicrosoftIdentity() {
  await linkIdentity("azure");
}
