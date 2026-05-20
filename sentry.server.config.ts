/**
 * Sentry — Node server runtime init.
 *
 * Catches unhandled exceptions in API routes, server actions, RSC render.
 * Same env-aware policy as the client config.
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
    // Drop request bodies — they may contain PII (customer details,
    // invoice amounts). Sentry's default `beforeSendTransaction` keeps
    // headers/URL only, which is what we want.
  });
}
