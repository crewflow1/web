"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * Customer-side error boundary (HQ-12.polish).
 *
 * The root /app/error.tsx is the catch-all for unauthenticated /
 * marketing surfaces. This one wraps the (app) route group, so a
 * customer hitting an unexpected error sees a friendlier shell
 * with navigation back to their workspace + a direct link into
 * Support (which is now a real ticket system, not an email
 * mailto:).
 */
export default function CustomerAppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // TODO when Sentry lands: Sentry.captureException(error)
    console.error("[customer-app] error boundary", error);
  }, [error]);

  return (
    <main className="flex min-h-[60vh] flex-col items-center justify-center py-16 text-center">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
        Workspace
      </p>
      <h1 className="mt-2 text-3xl font-bold text-slate-900">
        Something went wrong on our side
      </h1>
      <p className="mt-3 max-w-md text-sm text-slate-600">
        Sorry — the page couldn&apos;t load. Try again, or open a support
        ticket and we&apos;ll dig in.
      </p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <button
          onClick={reset}
          className="rounded-md bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
        >
          Try again
        </button>
        <Link
          href="/dashboard"
          className="rounded-md border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Back to dashboard
        </Link>
        <Link
          href="/support/new"
          className="rounded-md border border-slate-300 bg-white px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Raise a ticket
        </Link>
      </div>
      {error.digest ? (
        <p className="mt-8 text-xs text-slate-400">
          Reference: {error.digest}
        </p>
      ) : null}
    </main>
  );
}
