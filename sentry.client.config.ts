/**
 * Sentry — browser SDK init.
 *
 * Loaded by Next.js at app startup (App Router). Reports React errors,
 * route navigation errors, unhandled rejections.
 *
 * Disabled in development (we don't want dev console noise nor to burn
 * the Sentry event quota). Preview + production both enabled and tagged
 * by VERCEL_ENV.
 */

import * as Sentry from "@sentry/nextjs";
import { monitoringEnabled } from "@/lib/monitoring/readiness";
import { scrubEvent } from "@/lib/monitoring/scrub";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
const env = process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
const enabled = monitoringEnabled({ dsn, env });

if (enabled) {
  Sentry.init({
    dsn,
    environment: env,
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
    // 10% trace sampling — enough to spot patterns without paying for everything.
    tracesSampleRate: env === "production" ? 0.1 : 0.5,
    // Replays are deliberately off until we cost-model the quota.
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    // Redact secrets/PII before any event leaves the browser (see
    // lib/monitoring/scrub.ts).
    beforeSend: scrubEvent,
  });
}
