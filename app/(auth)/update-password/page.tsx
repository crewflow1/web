import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { UpdatePasswordForm } from "./_update-form";

/**
 * Set a new password. Requires a live session, reached either from a recovery
 * link (the /auth/callback established a recovery session and forwarded here)
 * or by an already-signed-in user changing their password. No session → back
 * to the reset request page rather than a silent dead-end.
 */
export default async function UpdatePasswordPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/reset-password");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Set a new password</h1>
        <p className="mt-1 text-sm text-slate-600">
          Choose a password for {user.email ?? "your account"}. You&apos;ll still be
          able to sign in with Google or a magic link too.
        </p>
      </div>

      <UpdatePasswordForm />
    </div>
  );
}
