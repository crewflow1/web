"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";

/**
 * Root global error boundary.
 *
 * This is the ONLY boundary that catches errors thrown while rendering
 * the root layout itself — `app/error.tsx` renders *inside* the root
 * layout, so it cannot. A global-error must therefore declare its own
 * <html>/<body>. Sentry's automatic (onRequestError) instrumentation
 * does not see React render errors caught by a client error boundary,
 * so we capture explicitly here (this also resolves Sentry's build-time
 * "no global error handler" warning).
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col items-center justify-center bg-white px-6 py-16 text-center">
        <h1 className="text-3xl font-bold text-slate-900">
          Something went wrong
        </h1>
        <p className="mt-3 max-w-md text-sm text-slate-600">
          Sorry, CrewFlow hit an unexpected error. Try again, or email{" "}
          <a className="underline" href="mailto:hello@crewflow.uk">
            hello@crewflow.uk
          </a>
          .
        </p>
        <button
          onClick={() => reset()}
          className="mt-6 rounded-md bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
        >
          Try again
        </button>
        {error.digest ? (
          <p className="mt-8 text-xs text-slate-500">Reference: {error.digest}</p>
        ) : null}
      </body>
    </html>
  );
}
