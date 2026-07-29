import * as Sentry from "@sentry/nextjs";

/**
 * Loud read failures — the fix for the silent-empty-state class.
 *
 * The bug this guards against: PostgREST rejects a whole query (PGRST201
 * ambiguous embed, RLS, network), the site destructures `const { data } =`
 * and renders `data ?? []` — so a FAILED read is indistinguishable from an
 * EMPTY one. /assets/holdings showed "Nothing is checked out" for weeks while
 * every request errored (the fleet migration's second FK to `assets` made the
 * bare `assets(...)` embed ambiguous).
 *
 * Two paths, matching how the failure must surface:
 *
 * - `readFailure(context, error)` — for FULL-PAGE primary reads. Returns an
 *   Error for the caller to THROW: the route-group error boundary renders
 *   "Something went wrong" and Next's `onRequestError` instrumentation
 *   (instrumentation.ts) captures it to Sentry. Deliberately does NOT capture
 *   here — the throw path is already monitored, capturing twice would
 *   double-report.
 *
 * - `reportReadFailure(context, error)` — for PANELS/SECTIONS inside a page
 *   that stays useful without them (job hub panels, dashboard tiles). The
 *   caller renders an EXPLICIT inline error state instead of throwing, so
 *   nothing else will reach Sentry — this captures + logs, then the caller
 *   shows the error block. Never let the panel render its empty state on
 *   error: an empty state on failure is the lie this module exists to stop.
 *
 * Message shape follows the existing service idiom
 * (server/services/receptionist-claim-view.ts): "<context> read failed: ...",
 * with the PostgREST error code when present so PGRST201-class rejections are
 * identifiable straight from the Sentry title.
 */

export type SupabaseReadError = {
  message?: string | null;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
};

function describe(context: string, error: SupabaseReadError): string {
  const code = error.code ? `[${error.code}] ` : "";
  return `${context} read failed: ${code}${error.message ?? "unknown error"}`;
}

/** Build the Error for a full-page read to throw (onRequestError captures it). */
export function readFailure(context: string, error: SupabaseReadError): Error {
  return new Error(describe(context, error));
}

/**
 * Report a panel-scoped read failure (Sentry + console), for callers that
 * render an inline error state instead of throwing.
 */
export function reportReadFailure(context: string, error: SupabaseReadError): void {
  const err = new Error(describe(context, error));
  Sentry.captureException(err);
  console.error(`[read-failure] ${err.message}`, error.details ?? "", error.hint ?? "");
}
