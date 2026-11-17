/**
 * Sentry — browser SDK init.
 *
 * Loaded by Next.js at app startup (App Router). Reports React errors,
 * route navigation errors, unhandled rejections.
 *
 * Runs BEFORE any consent interaction, on every page — so everything it sends
 * other than an actual error report is consent-gated in the transport below.
 *
 * Disabled in development (we don't want dev console noise nor to burn
 * the Sentry event quota). Preview + production both enabled and tagged
 * by VERCEL_ENV.
 */

import * as Sentry from "@sentry/nextjs";
import { categoryAllowedNow } from "@/lib/analytics/consent-client";
import {
  type MinimalEnvelope,
  type MinimalTransport,
  makeConsentGatedTransport,
} from "@/lib/monitoring/consent-transport";
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
    // Never attach default PII on the SDK's own initiative.
    sendDefaultPii: false,
    // Redact secrets/PII before any event leaves the browser (see
    // lib/monitoring/scrub.ts).
    beforeSend: scrubEvent,
    // Same redaction for performance (transaction) events, incl. span URL
    // fields (client pageload/navigation traces carry raw URLs).
    beforeSendTransaction: scrubEvent,
    // Consent gate (PECR). Error reports always go; session-health pings,
    // performance traces and every other non-error envelope are dropped unless
    // the visitor has granted the "performance" category — read live per send,
    // never on the customer portal / public quote / worker surfaces. See
    // lib/monitoring/consent-transport.ts for the line and the reasoning.
    transport: (options: Parameters<typeof Sentry.makeFetchTransport>[0]) =>
      makeConsentGatedTransport(
        Sentry.makeFetchTransport(options) as unknown as MinimalTransport<
          MinimalEnvelope,
          unknown
        >,
        () => categoryAllowedNow("performance"),
      ) as unknown as ReturnType<typeof Sentry.makeFetchTransport>,
  });
}
