/**
 * Product analytics (PostHog) — activation readiness.
 *
 * A sibling of lib/comms/readiness.ts and lib/monitoring/readiness.ts. Analytics
 * is DARK by default on two independent sinks; this reports each so a deploy's
 * true state ("integrated, but dark") is visible on /api/health rather than
 * assumed. Does NOT gate `ok` — dark analytics is a launch-readiness note, never
 * an outage.
 *
 * Decomposes into:
 *   clientConfigured — NEXT_PUBLIC_POSTHOG_KEY is present (the browser sink can
 *                      init, still subject to the consent gate at runtime).
 *   serverEnabled    — the server sink will capture: ANALYTICS_SERVER_ENABLED is
 *                      on ("1"/"true") AND POSTHOG_SERVER_KEY is present. Mirrors
 *                      serverAnalyticsEnabled() in lib/analytics/server.ts.
 *
 * Reads `process.env` DIRECTLY, imports no SDK and no `server-only`, so it is
 * edge-safe and CAN NEVER THROW. Emits BOOLEANS ONLY — never a key value nor the
 * names of the env vars; /api/health is public.
 */

const present = (v: string | undefined | null): boolean =>
  typeof v === "string" && v.trim().length > 0;

const flagOn = (v: string | undefined | null): boolean => {
  const s = (v ?? "").trim().toLowerCase();
  return s === "1" || s === "true";
};

export type AnalyticsReadiness = {
  clientConfigured: boolean;
  serverEnabled: boolean;
};

export function getAnalyticsReadiness(): AnalyticsReadiness {
  return {
    clientConfigured: present(process.env.NEXT_PUBLIC_POSTHOG_KEY),
    serverEnabled: flagOn(process.env.ANALYTICS_SERVER_ENABLED) && present(process.env.POSTHOG_SERVER_KEY),
  };
}
