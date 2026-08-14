/**
 * Sentry — Node server runtime init.
 *
 * Catches unhandled exceptions in API routes, server actions, RSC render.
 * Same env-aware policy as the client config.
 */

import * as Sentry from "@sentry/nextjs";
import { monitoringEnabled } from "@/lib/monitoring/readiness";
import { scrubEvent } from "@/lib/monitoring/scrub";

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
const env = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
// One source of truth for "will this runtime capture events?" — shared with
// the client/edge configs and /api/health via lib/monitoring/readiness.ts.
const enabled = monitoringEnabled({ dsn, env });

if (enabled) {
  Sentry.init({
    dsn,
    environment: env,
    release: process.env.VERCEL_GIT_COMMIT_SHA,
    tracesSampleRate: env === "production" ? 0.1 : 0.5,
    // Redact secrets/PII (Authorization, cookies, api_key query params,
    // request bodies, user PII) before any event leaves the process. Request
    // bodies may carry customer details + invoice amounts; headers may carry
    // the Supabase keys. See lib/monitoring/scrub.ts.
    beforeSend: scrubEvent,
  });
}
