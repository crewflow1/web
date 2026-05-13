"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Block 2 wires this to Sentry.captureException(error)
    // eslint-disable-next-line no-console
    console.error(error);
  }, [error]);

  return (
    <main className="container flex min-h-screen flex-col items-center justify-center py-16 text-center">
      <h1 className="text-3xl font-bold text-slate-900">Something went wrong</h1>
      <p className="mt-3 max-w-md text-slate-600">
        Sorry — we hit an error loading this page. Try again, or message us at{" "}
        <a className="underline" href="mailto:hello@crewflow.uk">
          hello@crewflow.uk
        </a>
        .
      </p>
      <button
        onClick={reset}
        className="mt-6 rounded-md bg-slate-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
      >
        Try again
      </button>
      {error.digest ? (
        <p className="mt-8 text-xs text-slate-400">Reference: {error.digest}</p>
      ) : null}
    </main>
  );
}
