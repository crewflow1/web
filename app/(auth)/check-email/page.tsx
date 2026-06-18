import Link from "next/link";
import { signInWithMagicLink } from "../actions";
import { FadeIn } from "@/components/ui";

type SearchParams = Promise<{ email?: string }>;

/**
 * Confirmation page after the magic-link form on /login was submitted.
 *
 * Sprint A friction-removal: a "Resend link" button (only when we know
 * the email) calls the same `signInWithMagicLink` server action that
 * /login uses. No new endpoint, no new module — just a form posting
 * the same email back.
 */
export default async function CheckEmailPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { email } = await searchParams;
  return (
    <FadeIn className="space-y-4 text-center">
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
      <p className="text-sm text-slate-600">
        We&apos;ve sent a magic sign-in link to{" "}
        <strong className="text-slate-900">{email ?? "your inbox"}</strong>.
        Click the link in the email to sign in.
      </p>
      <p className="text-xs text-slate-500">
        The link expires in 15 minutes. Most arrive within a minute.
      </p>
      <div className="mx-auto max-w-sm rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-left text-xs text-amber-900">
        Don&apos;t see it? Check your <strong>spam or junk</strong> folder. If
        it&apos;s there, mark it &ldquo;not spam&rdquo; so future sign-in links
        land in your inbox.
      </div>

      {email ? (
        <form
          action={signInWithMagicLink}
          className="flex flex-col items-center gap-2 pt-2"
        >
          <input type="hidden" name="email" value={email} />
          <button
            type="submit"
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
          >
            Resend the link
          </button>
          <p className="text-[11px] text-slate-500">
            Or{" "}
            <Link href="/login" className="font-medium text-slate-900 underline">
              use a different email
            </Link>
            .
          </p>
        </form>
      ) : (
        <p className="text-xs text-slate-500">
          <Link href="/login" className="font-medium text-slate-900 underline">
            Try again
          </Link>
        </p>
      )}
    </FadeIn>
  );
}
