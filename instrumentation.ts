/**
 * Next.js instrumentation hook — runs once per process before any
 * request handler. Dispatches Sentry init based on runtime.
 *
 * See https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    // Register the server-side analytics sink so #917's server-action
    // `trackEvent` emits reach a provider WHEN configured. Dark by default:
    // with no opt-in flag + server key this registers nothing and `trackEvent`
    // stays a server-side no-op. Node runtime only (posthog-node needs Node).
    const { ensureServerAnalyticsSink } = await import("@/lib/analytics/server");
    await ensureServerAnalyticsSink();
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Sentry SDK consumes this — re-export their hook.
export { captureRequestError as onRequestError } from "@sentry/nextjs";
