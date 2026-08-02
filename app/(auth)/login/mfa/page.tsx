import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { safeInternalPath } from "@/server/auth/safe-path";
import { MfaChallengeForm } from "./_mfa-challenge-form";

type SearchParams = Promise<{ next?: string }>;

/**
 * MFA (TOTP) login challenge.
 *
 * Reached after a password sign-in when the user has a VERIFIED TOTP factor:
 * the session exists at aal1 and this step upgrades it to aal2.
 *
 * Guard rails (no lockout):
 *   - No session → back to /login (the challenge needs a live session).
 *   - No verified factor → nothing to challenge, straight to /dashboard.
 * MFA is opt-in; users who never enrolled never land here.
 */
export default async function MfaChallengePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { next } = await searchParams;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: factors } = await supabase.auth.mfa.listFactors();
  const hasVerified = (factors?.totp ?? []).some((f) => f.status === "verified");
  if (!hasVerified) {
    // Nothing to verify — don't strand the user on a dead page.
    redirect(safeInternalPath(next) ?? "/dashboard");
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Two-factor verification</h1>
        <p className="mt-1 text-sm text-slate-600">
          Enter the 6-digit code from your authenticator app to finish signing in.
        </p>
      </div>

      <MfaChallengeForm next={next} />
    </div>
  );
}
