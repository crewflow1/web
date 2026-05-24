"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * /admin/* error boundary — catches runtime errors thrown inside HQ
 * pages so they don't fall through to the unstyled root boundary.
 * The Reset button calls the framework-provided `reset()` so the
 * boundary can re-render without a full reload.
 *
 * Errors are logged to the console and (in prod) Sentry via the
 * Sentry SDK's automatic instrumentation. The user-facing copy is
 * deliberately calm — the HQ operator is technical, but a noisy
 * stack trace isn't useful here.
 */
export default function HqError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[admin/error] HQ page crashed", {
      message: error.message,
      digest: error.digest,
    });
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl space-y-6 py-10">
      <header>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-red-600">
          HQ error
        </p>
        <h1 className="mt-1 text-2xl font-bold text-slate-900">
          Something went wrong in HQ.
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          The page hit a runtime error. Auth, RLS, and the audit log
          are unaffected. Try the page again, or jump back to overview.
        </p>
      </header>

      <div className="rounded-xl border border-red-200 bg-red-50 p-4">
        <p className="text-xs font-semibold text-red-900">Error</p>
        <p className="mt-1 break-all font-mono text-xs text-red-800">
          {error.message || "Unknown error"}
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-[10px] text-red-700">
            digest: {error.digest}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
        >
          Try again
        </button>
        <Link
          href="/admin/overview"
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Back to overview
        </Link>
        <Link
          href="/admin/support"
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Open support queue
        </Link>
      </div>
    </div>
  );
}
