import { CheckEmailDetails } from "../_magic-link.client";

/**
 * Confirmation page after the magic-link form on /login was submitted.
 *
 * Sprint A friction-removal: a "Resend the link" button calls the same
 * `signInWithMagicLink` server action that /login uses (rendered by
 * CheckEmailDetails; with no remembered address it shows "Try again").
 *
 * PRIVACY: this page takes NO query parameters. The address the person typed
 * is never put in the URL (it reached request logs, history and analytics
 * page views); see app/(auth)/_magic-link.client.tsx for how the page learns it.
 */
export default function CheckEmailPage() {
  return (
    <div className="space-y-4 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-6 w-6 text-slate-700"
        >
          <rect width="20" height="16" x="2" y="4" rx="2" />
          <path d="m22 7-10 5L2 7" />
        </svg>
      </div>

      <h1 className="text-2xl font-bold text-slate-900">Check your email</h1>
      <CheckEmailDetails />
    </div>
  );
}
