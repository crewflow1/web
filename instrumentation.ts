/**
 * Next.js instrumentation hook — runs once per process before any
 * request handler. Dispatches Sentry init based on runtime.
 *
 * See https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

// Sentry SDK consumes this — re-export their hook.
export { captureRequestError as onRequestError } from "@sentry/nextjs";
