/**
 * Sentry — Edge runtime init.
 *
 * Used by Next.js middleware + any Edge route. Minimal config — Edge
 * has fewer Node primitives, so we stick to error capture only.
 */

import * as Sentry from "@sentry/nextjs";
import { monitoringEnabled } from "@/lib/monitoring/readiness";
import { scrubEvent } from "@/lib/monitoring/scrub";

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
const env = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
const enabled = monitoringEnabled({ dsn, env });

if (enabled) {
  Sentry.init({
    dsn,
    environment: env,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: env === "production" ? 0.1 : 0.5,
    // Redact secrets/PII before any event leaves the process (edge-safe;
    // see lib/monitoring/scrub.ts).
    beforeSend: scrubEvent,
  });
}
