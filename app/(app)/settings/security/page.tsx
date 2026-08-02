import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/server/auth/session";
import { env } from "@/lib/env";
import {
  MfaSection,
  LinkingSection,
  type FactorView,
  type IdentityView,
} from "./_forms";

/**
 * Account security — two-factor authentication (opt-in) + linked sign-in
 * methods. ADDITIVE and self-service; nothing here changes how existing
 * magic-link / Google users sign in, and MFA is never enforced.
 *
 * Uses requireUser (not requireOrgContext) so it stays reachable regardless of
 * org/onboarding state — a user must always be able to manage their own
 * security, and to REMOVE a factor for recovery.
 */
export default async function SecuritySettingsPage() {
  const user = await requireUser();
  const supabase = await createClient();

  // Bind the error: a failed factors read must NOT render as a healthy "no MFA
  // set up" state (that would mislead a user into thinking their 2FA vanished).
  // We surface a load error instead — but still render the page so factor
  // REMOVAL (recovery) stays reachable even on a transient read blip.
  const { data: factorData, error: factorError } =
    await supabase.auth.mfa.listFactors();
  const factors: FactorView[] = (factorData?.all ?? []).map((f) => ({
    id: f.id,
    friendlyName: f.friendly_name ?? null,
    status: f.status,
  }));

  const identities: IdentityView[] = (user.identities ?? []).map((i) => ({
    provider: i.provider,
  }));

  const linkingEnabled = env.NEXT_PUBLIC_FEATURE_ACCOUNT_LINKING === "true";

  return (
    <div className="mx-auto max-w-2xl space-y-6 py-8">
      <div>
        <Link href="/settings" className="text-sm text-slate-500 hover:underline">
          ← Settings
        </Link>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">Security</h1>
      </div>

      <MfaSection factors={factors} loadError={!!factorError} />

      <LinkingSection
        identities={identities}
        googleEnabled={linkingEnabled}
        microsoftEnabled={
          linkingEnabled && env.NEXT_PUBLIC_FEATURE_MICROSOFT_SSO === "true"
        }
      />
    </div>
  );
}
