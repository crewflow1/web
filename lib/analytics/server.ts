/**
 * Server-side product-analytics capture sink — the server-runtime counterpart
 * of the browser sink in `lib/analytics/load.ts`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `trackEvent` (`lib/analytics/events.ts`) forwards to a sink registered via
 * `setAnalyticsSink`. The ONLY existing registrar is `loadAnalyticsIfAllowed`,
 * which runs in the BROWSER after a consent-gated PostHog init. All #917 funnel
 * emits, however, fire from SERVER ACTIONS / ROUTES (org/customer/job/quote/
 * invoice/payment/staff/onboarding). On the server there was no sink, so every
 * one of those `trackEvent` calls is an inert no-op — even after a founder sets
 * a key. This module adds the missing server registrar.
 *
 * SAFETY CONTRACT (all must hold — this stays DARK by default)
 * ------------------------------------------------------------
 *   - Dark by default: registers NOTHING unless BOTH an explicit server opt-in
 *     flag is on AND a server ingestion key is present. Absent either → no-op.
 *     No key or flag is added by this change; activation is a founder env-only
 *     decision (CLAUDE.md: providers dark by default; MOE approval required).
 *   - Server-only: imports `server-only` so it can never be pulled into a client
 *     bundle, and the provider client (`posthog-node`) is loaded via dynamic
 *     import so it is tree-shaken out of every client bundle and only resolved
 *     when actually enabled.
 *   - No PII: the sink forwards only the already-sanitised `SafeEventProperties`
 *     (primitives, PII/money/free-text keys dropped by `sanitizeEventProperties`
 *     upstream — same #917 contract). It adds nothing of its own except a
 *     pseudonymous `org_id`-derived distinct id.
 *   - No secret leakage: the key is read from env only and is NEVER logged.
 *   - Failure isolation: capture is wrapped so a provider/network error can
 *     never propagate into the product action (`trackEvent` also wraps the sink,
 *     giving defence in depth).
 */

import "server-only";

import {
  setAnalyticsSink,
  type AnalyticsEventName,
  type AnalyticsSink,
  type SafeEventProperties,
} from "@/lib/analytics/events";

/**
 * Minimal structural type for the capture client the sink drives. Kept tiny and
 * provider-agnostic so tests can inject a fake and so this module does not
 * statically depend on `posthog-node` (that is loaded lazily — see below).
 */
export interface ServerCaptureClient {
  capture(payload: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
  }): void;
}

/** Env inputs the gate reads. Passed explicitly so the gate is pure + testable. */
export interface ServerAnalyticsEnv {
  /** Explicit server opt-in flag — the "enabled/disabled" control. */
  enabled?: string | null;
  /** Server ingestion key (NOT a `NEXT_PUBLIC_` var — never shipped to clients). */
  key?: string | null;
  /** PostHog host; defaults to the EU ingestion host when enabled. */
  host?: string | null;
}

/** A truthy string flag: "1" / "true" (case-insensitive). Everything else is off. */
function flagEnabled(raw: string | null | undefined): boolean {
  if (typeof raw !== "string") return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true";
}

/** A non-empty, non-blank key. */
function hasKey(raw: string | null | undefined): boolean {
  return typeof raw === "string" && raw.trim().length > 0;
}

/**
 * The load-bearing gate: server capture may run ONLY when the opt-in flag is on
 * AND a server key is present. Either missing → disabled (dark). Pure function
 * so the dark-by-default guarantee is directly unit-testable.
 */
export function serverAnalyticsEnabled(env: ServerAnalyticsEnv): boolean {
  return flagEnabled(env.enabled) && hasKey(env.key);
}

/**
 * Build an {@link AnalyticsSink} over a capture client. The properties arriving
 * here are ALREADY sanitised by `trackEvent` → `sanitizeEventProperties`, so no
 * PII/money/free-text can reach the client. Org-first: the distinct id is the
 * pseudonymous `org_id` when present, else a fixed non-identifying fallback — we
 * never mint a per-person identity server-side. Never throws.
 */
export function createServerSink(client: ServerCaptureClient): AnalyticsSink {
  return (event: AnalyticsEventName, properties: SafeEventProperties): void => {
    try {
      const org = properties.org_id;
      const distinctId =
        typeof org === "string" && org.length > 0 ? org : "server";
      client.capture({ distinctId, event, properties });
    } catch {
      // Swallow — a telemetry/provider failure must never surface to the caller.
    }
  };
}

// ---------------------------------------------------------------------------
// One-time registration (called from instrumentation `register()`).
// ---------------------------------------------------------------------------

let registered = false;

/** Default env snapshot — read from `process.env` only, key never logged. */
function envFromProcess(): ServerAnalyticsEnv {
  return {
    enabled: process.env.ANALYTICS_SERVER_ENABLED ?? null,
    key: process.env.POSTHOG_SERVER_KEY ?? null,
    host: process.env.POSTHOG_SERVER_HOST ?? null,
  };
}

/**
 * Register the server analytics sink IF enabled. Idempotent and inert by
 * default: with the flag off or no key it registers nothing and returns false,
 * so `trackEvent` stays a server-side no-op. Only when enabled does it lazily
 * import `posthog-node`, construct a client and register the sink. Never throws.
 *
 * Returns whether a sink was registered (useful for tests / boot diagnostics).
 */
export async function ensureServerAnalyticsSink(
  env: ServerAnalyticsEnv = envFromProcess(),
): Promise<boolean> {
  if (registered) return true;
  if (!serverAnalyticsEnabled(env)) return false; // dark — register nothing

  try {
    const { PostHog } = await import("posthog-node");
    const client = new PostHog((env.key as string).trim(), {
      host: (env.host && env.host.trim()) || "https://eu.i.posthog.com",
      // Server actions are short-lived; flush promptly rather than batching for
      // a long-running process. (Activation follow-up: pair capture with a
      // `waitUntil(client.flush())` on serverless so in-flight events are not
      // dropped when the lambda freezes. Out of scope while dark.)
      flushAt: 1,
      flushInterval: 0,
    });
    setAnalyticsSink(
      createServerSink({
        capture: (payload) => client.capture(payload),
      }),
    );
    registered = true;
    return true;
  } catch {
    // Provider import/construction failure must never break server boot.
    return false;
  }
}

/** Test-only: reset the one-time registration guard. */
export function __resetServerAnalyticsForTest(): void {
  registered = false;
  setAnalyticsSink(null);
}
