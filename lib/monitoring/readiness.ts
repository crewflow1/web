/**
 * Error-monitoring — activation readiness.
 *
 * A sibling of lib/comms/readiness.ts, lib/weather/readiness.ts and
 * lib/integrations/readiness.ts, written in the same style and for the same
 * reason: a single "monitoring on?" boolean derived from configuration is a
 * lie whenever the runtime cannot actually report an error, and a green light
 * over a dead path is worse than no light — it suppresses the alarm that would
 * have caught the misconfiguration.
 *
 * The specific failure this prevents: a deploy ships the Sentry SDK wiring
 * (instrumentation.ts + the three sentry.*.config.ts files) but NO DSN, so
 * nothing initialises and no error is ever reported — yet an operator assumes
 * "we have Sentry" and stops watching. This module makes the true state
 * ("integrated, but dark — no DSN") visible on /api/health instead.
 *
 * Readiness decomposes into independently-verifiable facts:
 *
 *   sdkIntegrated  — the SDK wiring EXISTS in this build (instrumentation.ts
 *                    + sentry.{server,client,edge}.config.ts). Build-time
 *                    fact — no env var can flip it. TRUE.
 *   dsnConfigured  — a DSN is present in this environment.   (configuration)
 *   enabled        — monitoring will ACTUALLY capture events here: the SDK is
 *                    integrated, a DSN is set, and the environment is not one
 *                    where we deliberately stay silent (development / test).
 *                    FALSE in every environment today — no DSN is set anywhere,
 *                    which is the dark-gating doctrine: no DSN ⇒ inert.
 *
 * THE LOAD-BEARING RULE, inherited from its siblings:
 * **`enabled` can NEVER be true without `sdkIntegrated`.** No environment
 * variable can manufacture a capability this build does not contain.
 *
 * Reads `process.env` DIRECTLY (not the validated `env` object), imports no
 * SDK and no `server-only`, so it is edge-safe (`/api/health` runs on the edge
 * runtime), dependency-free, and CAN NEVER THROW — a readiness probe must
 * always answer.
 *
 * Emits BOOLEANS ONLY (plus the environment name, which /api/health already
 * exposes). It never returns the DSN value nor the names of the env vars that
 * hold it — the health endpoint is public, and a secret must not leak through
 * a diagnostic.
 */

// ---------------------------------------------------------------------------
// Build-time capability registry.
// ---------------------------------------------------------------------------

/**
 * Does this build contain the Sentry SDK wiring?
 *
 * A BUILD-TIME fact — it answers "is there code that CAN initialise error
 * capture", which no env var can change. TRUE because instrumentation.ts and
 * sentry.{server,client,edge}.config.ts all exist. A hand-maintained constant
 * in the spirit of `SENDER_IMPLEMENTED` (comms) and `PROVIDER_IMPLEMENTED`
 * (weather); the drift test in __tests__/monitoring/readiness.test.ts ties it
 * to the real files, so deleting the wiring flips this to a required false.
 */
const SDK_INTEGRATED = true;

/**
 * The environments where we deliberately stay silent even if a DSN is set —
 * mirrors the `env !== "development" && env !== "test"` guard the three
 * sentry.*.config.ts files apply, kept HERE so there is one source of truth
 * that both the configs and this readiness probe consume.
 */
const SILENT_ENVIRONMENTS = ["development", "test"] as const;

const present = (v: string | undefined | null): boolean =>
  typeof v === "string" && v.trim().length > 0;

/**
 * The single enable predicate the SDK configs share.
 *
 * Extracted so "will this runtime capture events?" is decided in ONE place and
 * is directly unit-testable — a test can prove init is a no-op when the DSN is
 * unset without importing the Sentry SDK. The three sentry.*.config.ts files
 * call this instead of re-deriving the boolean, so they can never drift apart.
 */
export function monitoringEnabled(args: {
  dsn: string | undefined | null;
  env: string | undefined | null;
}): boolean {
  const env = (args.env ?? "development").trim().toLowerCase();
  return (
    SDK_INTEGRATED &&
    present(args.dsn) &&
    !(SILENT_ENVIRONMENTS as readonly string[]).includes(env)
  );
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export type MonitoringReadiness = {
  /** The SDK wiring exists in this build. Build-time fact — TRUE. */
  sdkIntegrated: boolean;
  /** A DSN is present in this environment. Configuration. */
  dsnConfigured: boolean;
  /**
   * Monitoring will ACTUALLY capture events here — integrated AND a DSN is set
   * AND the environment is not one we silence. FALSE everywhere today (no DSN),
   * and never true without `sdkIntegrated`.
   */
  enabled: boolean;
  /** The environment name, normalised. Safe to expose (health already does). */
  environment: string;
};

/**
 * Compose monitoring readiness for the current runtime.
 *
 * Reads both the server DSN (`SENTRY_DSN`) and the public DSN
 * (`NEXT_PUBLIC_SENTRY_DSN`) because either one arming monitoring counts as
 * "configured" — the server/edge configs fall back to the public DSN, exactly
 * as sentry.server.config.ts does. `environment` mirrors the same precedence
 * the SDK configs use so the reported state matches what would actually run.
 */
export function getMonitoringReadiness(): MonitoringReadiness {
  const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
  const environment = (
    process.env.VERCEL_ENV ??
    process.env.NODE_ENV ??
    "development"
  )
    .trim()
    .toLowerCase();

  const dsnConfigured = present(dsn);
  const enabled = monitoringEnabled({ dsn, env: environment });

  return {
    sdkIntegrated: SDK_INTEGRATED,
    dsnConfigured,
    enabled,
    environment,
  };
}
