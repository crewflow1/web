import { signInWithGoogle, signInWithMicrosoft } from "../actions";
import { EmailPasswordForm } from "../_email-password-form";
import { MagicLinkForm } from "../_magic-link.client";
import { env } from "@/lib/env";

// No `email` parameter: an address in a URL reaches request logs, history and
// analytics page views (privacy finding G-10). Nothing redirects here with one.
type SearchParams = Promise<{
  error?: string;
  next?: string;
}>;

// Messages map. Errors that are recoverable by "request a new magic link"
// are styled to nudge the user to the form below, the failing sign-in
// link is single-use and the recovery is literally one click + one form.
const ERROR_MESSAGES: Record<
  string,
  { msg: string; recoverable: boolean }
> = {
  invalid_email: {
    msg: "Please enter a valid email address.",
    recoverable: false,
  },
  missing_code: {
    msg: "That sign-in link didn't carry the verification code. Enter your email below and we'll send a fresh one.",
    recoverable: true,
  },
  auth_failed: {
    msg: "We couldn't complete the sign-in. Enter your email below, or try Google above, to start over.",
    recoverable: true,
  },
  magic_link_used: {
    msg: "That sign-in link was already used. Enter your email below and we'll send you a fresh one (works any number of times).",
    recoverable: true,
  },
  magic_link_expired: {
    msg: "That sign-in link has expired. Enter your email below and we'll send a fresh one.",
    recoverable: true,
  },
  magic_link_invalid: {
    msg: "That sign-in link looks invalid. Enter your email below and we'll send a fresh one.",
    recoverable: true,
  },
  provider_error: {
    msg: "Our sign-in provider had a hiccup. Try again, Google works as a faster alternative.",
    recoverable: true,
  },
  bootstrap_failed: {
    msg: "Your account exists but a setup step failed. Try signing in again, if it persists, email hello@crewflow.uk.",
    recoverable: true,
  },
  oauth_start_failed: {
    msg: "We couldn't start the sign-in. Please try again.",
    recoverable: false,
  },
  rate_limited: {
    msg: "Too many sign-in attempts. Please wait a few minutes and try again.",
    recoverable: false,
  },
  magic_link_send_failed: {
    msg: "We couldn't send a sign-in link to that address. Check it and try again.",
    recoverable: true,
  },
  oauth_no_url: {
    msg: "We couldn't start the sign-in. Please try again.",
    recoverable: false,
  },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const errorEntry = sp.error ? ERROR_MESSAGES[sp.error] : null;
  // Only KNOWN codes render their own text. Anything else gets a generic message —
  // the page never echoes URL text, so a crafted link cannot put its own wording here.
  const errorMessage = errorEntry
    ? errorEntry.msg
    : sp.error
      ? "We couldn't complete the sign-in. Please try again."
      : null;
  const isRecoverableError = errorEntry?.recoverable ?? false;
  const nextHint = sp.next ?? "";
  const microsoftEnabled = env.NEXT_PUBLIC_FEATURE_MICROSOFT_SSO === "true";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Sign in</h1>
        <p className="mt-1 text-sm text-slate-600">
          Use Google for the fastest sign-in, or get a magic link by email.
        </p>
      </div>

      {errorMessage ? (
        <div
          role="alert"
          className={
            isRecoverableError
              ? "rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
              : "rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          }
        >
          {errorMessage}
        </div>
      ) : null}

      <div className="space-y-3">
        <form action={signInWithGoogle}>
          <button
            type="submit"
            className="flex w-full items-center justify-center gap-3 rounded-md border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-slate-50"
          >
            <GoogleIcon className="h-5 w-5" />
            Continue with Google
          </button>
        </form>

        {/* Microsoft SSO, DARK by default. Only renders when the Azure
            provider credential is configured (NEXT_PUBLIC_FEATURE_MICROSOFT_SSO).
            No broken/fake button while off. */}
        {microsoftEnabled ? (
          <form action={signInWithMicrosoft}>
            <button
              type="submit"
              className="flex w-full items-center justify-center gap-3 rounded-md border border-slate-300 bg-white px-4 py-3 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-slate-50"
            >
              <MicrosoftIcon className="h-5 w-5" />
              Continue with Microsoft
            </button>
          </form>
        ) : null}
      </div>

      <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-slate-500">
        <div className="h-px flex-1 bg-slate-200" />
        <span>or with a magic link</span>
        <div className="h-px flex-1 bg-slate-200" />
      </div>

      <MagicLinkForm recoverable={isRecoverableError} />

      <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-slate-500">
        <div className="h-px flex-1 bg-slate-200" />
        <span>or use a password</span>
        <div className="h-px flex-1 bg-slate-200" />
      </div>

      {/* Email + password, ADDITIVE. Existing Google + magic-link above are
          unchanged; a passwordless user simply has no password and keeps using
          those. */}
      <EmailPasswordForm next={nextHint || undefined} />

      <p className="text-center text-xs text-slate-500">
        By continuing you agree to CrewFlow&apos;s Terms and acknowledge our Privacy Policy.
      </p>
    </div>
  );
}

function MicrosoftIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path d="M11.4 11.4H2V2h9.4v9.4Z" fill="#F25022" />
      <path d="M22 11.4h-9.4V2H22v9.4Z" fill="#7FBA00" />
      <path d="M11.4 22H2v-9.4h9.4V22Z" fill="#00A4EF" />
      <path d="M22 22h-9.4v-9.4H22V22Z" fill="#FFB900" />
    </svg>
  );
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09Z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.99.66-2.25 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.11A6.6 6.6 0 0 1 5.5 12c0-.74.13-1.45.34-2.11V7.05H2.18A11 11 0 0 0 1 12c0 1.78.43 3.46 1.18 4.95l3.66-2.84Z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.46 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z"
        fill="#EA4335"
      />
    </svg>
  );
}
