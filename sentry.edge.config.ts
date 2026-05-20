/**
 * Sentry — Edge runtime init.
 *
 * Used by Next.js middleware + any Edge route. Minimal config — Edge
 * has fewer Node primitives, so we stick to error capture only.
 */

import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
const env = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
const enabled = !!dsn && env !== "development" && env !== "test";

if (enabled) {
  Sentry.init({
    dsn,
    environment: env,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: env === "production" ? 0.1 : 0.5,
  });
}
