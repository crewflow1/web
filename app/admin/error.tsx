"use client";

import { useEffect } from "react";
import * as Sentry from "@sentry/nextjs";
import { Button, ButtonLink } from "@/components/ui";

/**
 * /admin/* error boundary — catches runtime errors thrown inside HQ
 * pages so they don't fall through to the unstyled root boundary.
 * The Reset button calls the framework-provided `reset()` so the
 * boundary can re-render without a full reload.
 *
 * Errors are captured to Sentry explicitly (React error boundaries
 * swallow client-side render errors, so the SDK's automatic
 * onRequestError instrumentation never sees them) and logged to the
 * console for local dev. The user-facing copy is deliberately calm —
 * the HQ operator is technical, but a noisy stack trace isn't useful here.
 */
export default function HqError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
    console.error("[admin/error] HQ page crashed", {
      message: error.message,
      digest: error.digest,
    });
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl space-y-6 py-10">
      <header>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-rose-400">
          HQ error
        </p>
        <h1 className="mt-1 text-2xl font-bold text-white">
          Something went wrong in HQ.
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          The page hit a runtime error. Auth, RLS, and the audit log
          are unaffected. Try the page again, or jump back to overview.
        </p>
      </header>

      <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4">
        <p className="text-xs font-semibold text-rose-200">Error</p>
        <p className="mt-1 break-all font-mono text-xs text-rose-200/90">
          {error.message || "Unknown error"}
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-[10px] text-rose-300/80">
            digest: {error.digest}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="accent" onClick={() => reset()}>
          Try again
        </Button>
        <ButtonLink href="/admin/overview" variant="glass">
          Back to overview
        </ButtonLink>
        <ButtonLink href="/admin/support" variant="glass">
          Open support queue
        </ButtonLink>
      </div>
    </div>
  );
}
