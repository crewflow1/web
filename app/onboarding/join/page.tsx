import { redirect } from "next/navigation";
import { requireUser } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { Button } from "@/components/ui/button";
import { acceptOrgInvite } from "./actions";
import { readFailure } from "@/lib/supabase/read-failure";

/**
 * Invitation-acceptance page.
 *
 * When an owner adds a staff member whose email isn't yet a CrewFlow user,
 * we send a Supabase magic-link invite carrying invited_org_id + invited_role
 * in user_metadata. They land here after clicking it.
 *
 *   - User metadata.invited_org_id is the inviting org.
 *   - We look up the org name, ask the user to confirm.
 *   - On submit, server action inserts the membership + redirects to /dashboard.
 */
export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireUser();
  const sp = await searchParams;

  // Pull the invite intent from auth metadata. The client lib hides this
  // behind `user.user_metadata` after sign-in.
  const meta = (user.user_metadata ?? {}) as {
    invited_org_id?: string;
    invited_role?: string;
  };
  const orgId = meta.invited_org_id ?? null;
  const role = meta.invited_role === "admin" ? "admin" : "staff";

  // No invite metadata → fall back to the regular onboarding flow.
  if (!orgId) {
    redirect("/onboarding/company");
  }

  // If they're already a member, just go straight to the dashboard.
  const supabase = await createClient();
  const { data: existingMembership } = await supabase
    .from("memberships")
    .select("id")
    .eq("org_id", orgId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (existingMembership) redirect("/dashboard");

  // Look up the inviting org's name (admin client — RLS would block us
  // until membership exists).
  const admin = createAdminClient();
  const { data: org, error: orgError } = await admin
    .from("organizations")
    .select("id, name")
    .eq("id", orgId)
    .maybeSingle();
  // Loud fail: a query failure must not dump a validly-invited user into the
  // create-a-new-company flow (which could mint a duplicate org).
  if (orgError) throw readFailure("onboarding join: invite org", orgError);
  if (!org) {
    redirect("/onboarding/company?error=invite_org_missing");
  }

  const errorMessage = sp.error ? decodeURIComponent(sp.error) : null;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        You&apos;ve been invited
      </p>
      <h1 className="mt-2 text-2xl font-bold text-slate-900">
        Join {org.name} on CrewFlow
      </h1>
      <p className="mt-2 text-sm text-slate-600">
        You&apos;ll be added as <strong>{role}</strong>. You can update your
        profile (name, phone, emergency contact) after joining.
      </p>

      {errorMessage ? (
        <div role="alert" className="mt-5 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}

      <form action={acceptOrgInvite} className="mt-6 space-y-4">
        <label className="block text-xs font-medium text-slate-700">
          Your name
          <input
            name="full_name"
            type="text"
            required
            placeholder="e.g. Jane Smith"
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-900 focus:outline-none focus:ring-2 focus:ring-slate-900/10"
          />
        </label>
        <input type="hidden" name="org_id" value={orgId} />
        <input type="hidden" name="role" value={role} />
        <Button type="submit" size="lg" className="w-full">
          Join {org.name}
        </Button>
      </form>
    </div>
  );
}
