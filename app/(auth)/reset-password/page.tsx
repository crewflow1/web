import { ResetForm } from "./_reset-form";

/**
 * Request a password-reset email. Additive recovery entry point; does not
 * touch the magic-link or OAuth flows. Submitting always shows the same
 * neutral confirmation (no account-existence enumeration).
 */
export default function ResetPasswordPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Reset your password</h1>
        <p className="mt-1 text-sm text-slate-600">
          Enter your email and we&apos;ll send you a link to set a new password.
          Prefer not to? You can always sign in with a magic link or Google.
        </p>
      </div>

      <ResetForm />
    </div>
  );
}
