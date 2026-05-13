import Link from "next/link";

type SearchParams = Promise<{ email?: string }>;

export default async function CheckEmailPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { email } = await searchParams;
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
      <p className="text-sm text-slate-600">
        We&apos;ve sent a magic sign-in link to{" "}
        <strong className="text-slate-900">{email ?? "your inbox"}</strong>.
        Click the link in the email to sign in.
      </p>
      <p className="text-xs text-slate-500">
        The link expires in 15 minutes. Didn&apos;t get it? Check your spam folder, or{" "}
        <Link href="/login" className="font-medium text-slate-900 underline">
          try again
        </Link>
        .
      </p>
    </div>
  );
}
