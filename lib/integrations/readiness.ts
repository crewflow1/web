/**
 * Integrations readiness (Train 9 — public API-key foundation).
 *
 * The comms-readiness composition style (lib/comms/readiness.ts): readiness
 * is decomposed into independently-verifiable facts, and the headline can
 * never be true without its build-time half. Deliberately dependency-free —
 * no `server-only`, no provider SDK, no env reads — so it is edge-safe
 * (`/api/health` runs on the edge runtime) and CAN NEVER THROW.
 *
 * Everything here is a BUILD-TIME fact: the API-key substrate needs no
 * credentials and has no feature flag — either the resolver + probe exist in
 * this build or they don't. `__tests__/security/api-keys.test.ts` guards both
 * constants against drift: `implemented` must track the existence of
 * lib/api-auth/resolve.ts, and `endpoints` must equal the number of route
 * files under app/api/v1 — so this module can never report a surface that
 * was deleted, nor undercount one that grew without review.
 */

export type ApiKeysReadiness = {
  /**
   * The substrate exists in this build: keygen + resolver + admin UI.
   * A build-time fact — no env var can flip it (the SENDER_IMPLEMENTED rule).
   */
  implemented: boolean;
  /**
   * How many /api/v1 route files this build ships. Currently 3 — the
   * /api/v1/me probe plus the Train K jobs read pair (/api/v1/jobs and
   * /api/v1/jobs/[id]). The jobs routes ship DARK behind FEATURE_PUBLIC_API_JOBS
   * (they 404 until the CEO enables them), so this count is the built surface,
   * not the live one. The drift-guard test ties it to the real file count so a
   * route cannot be added or removed without a conscious diff here.
   */
  endpoints: number;
};

export type IntegrationsReadiness = {
  apiKeys: ApiKeysReadiness;
};

/** API-key substrate readiness. Build-time facts only. */
export function getApiKeysReadiness(): ApiKeysReadiness {
  return {
    // lib/api-auth/{keygen,resolve,scopes}.ts + app/api/v1/me/route.ts
    // + the Train K jobs read pair (dark behind FEATURE_PUBLIC_API_JOBS).
    implemented: true,
    endpoints: 3,
  };
}

/** One call for the integrations snapshot (health checks, monitoring). */
export function getIntegrationsReadiness(): IntegrationsReadiness {
  return { apiKeys: getApiKeysReadiness() };
}
