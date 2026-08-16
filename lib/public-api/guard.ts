import "server-only";
import { NextResponse } from "next/server";
import { resolveApiKey, type ResolvedApiKey } from "@/lib/api-auth/resolve";
import { hasScope, type Scope } from "@/lib/api-auth/scopes";
import {
  DEFAULT_LIMITS,
  enforceIdentified,
  enforceIdentifiedStrict,
} from "@/lib/security/rate-limit";
import { isPublicApiJobsEnabled } from "@/lib/public-api/flag";
import { logApiRequest } from "@/lib/public-api/audit";

/** The status stamped on the per-request audit row for an admitted request. */
const ADMITTED_STATUS = 200;

/** A write scope is the fail-CLOSED, mutating half of the surface. */
function isWriteScope(scope: Scope): boolean {
  return scope.startsWith("write:");
}

/**
 * The shared front door for EVERY /api/v1 tenant-data handler (Train K → the
 * Open-API expansion). One chokepoint so the jobs / customers / invoices /
 * quotes routes cannot drift in how they gate. In strict order:
 *
 *   1. FLAG — off ⇒ 404. The surface does not exist until the CEO enables it;
 *      a 401/403 here would leak that the endpoint is real-but-locked. 404 is
 *      the dark state. ALL v1 read surfaces share the ONE flag
 *      (FEATURE_PUBLIC_API_JOBS): flipping it is the whole activation decision.
 *   2. AUTH — resolveApiKey is the single authority (re-checks revoked/expired
 *      against Postgres every call, no cache) ⇒ 401 on missing/bad/revoked/
 *      expired.
 *   3. SCOPE — the per-resource read scope required ⇒ 403 without it. A live
 *      key that was not granted THIS capability is authenticated but forbidden,
 *      so a `read:jobs`-only key cannot read invoices.
 *   4. RATE LIMIT — keyed by the KEY ID (never IP), the api_v1 budget shared
 *      across every v1 route ⇒ 429 over budget. READS metre fail-open; WRITES
 *      (a `write:*` scope) metre fail-CLOSED — a limiter fault refuses the
 *      mutation rather than admitting it (see DEFAULT_LIMITS.api_v1).
 *   5. AUDIT — once admitted, one metadata-only row is written to
 *      api_request_log (method, route pathname, status). Best-effort; never
 *      breaks the admitted request. Denials (1–4) write nothing (see
 *      lib/public-api/audit.ts).
 *
 * Returns the resolved key on success, or a Response to return immediately.
 */
export type GuardResult =
  | { ok: true; key: ResolvedApiKey }
  | { ok: false; response: Response };

const notFound = (): Response =>
  NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

const unauthorized = (): Response =>
  NextResponse.json(
    { ok: false, error: "invalid_api_key" },
    {
      status: 401,
      // RFC 6750 — name the scheme this surface expects (mirrors /api/v1/me).
      headers: { "www-authenticate": 'Bearer realm="crewflow-api"' },
    },
  );

const forbidden = (scope: Scope = "read:jobs"): Response =>
  NextResponse.json(
    { ok: false, error: "insufficient_scope", required_scope: scope },
    {
      status: 403,
      headers: {
        "www-authenticate": `Bearer realm="crewflow-api", error="insufficient_scope", scope="${scope}"`,
      },
    },
  );

/**
 * The GENERIC gate every tenant-data v1 route calls, parameterised by the one
 * scope it demands. Same ordered flag → auth → scope → rate-limit contract as
 * the jobs guard below; the resource routes pass their own scope so a key is
 * checked for exactly the capability it is using.
 */
export async function guardPublicApiRequest(
  request: Request,
  requiredScope: Scope,
): Promise<GuardResult> {
  // 1. Flag — dark ⇒ 404, before we even look at the credential.
  if (!isPublicApiJobsEnabled()) return { ok: false, response: notFound() };

  // 2. Auth.
  const key = await resolveApiKey(request.headers.get("authorization"));
  if (!key) return { ok: false, response: unauthorized() };

  // 3. Scope — the exact per-resource capability this route needs.
  if (!hasScope(key.scopes, requiredScope)) {
    return { ok: false, response: forbidden(requiredScope) };
  }

  // 4. Rate limit — AFTER resolution, keyed by the key id (see DEFAULT_LIMITS
  //    .api_v1). The 401/403 paths above stay un-metered but are cheap. WRITES
  //    metre fail-CLOSED (a store fault refuses the mutation); reads fail-open.
  const limited = isWriteScope(requiredScope)
    ? await enforceIdentifiedStrict("api_v1", key.keyId, DEFAULT_LIMITS.api_v1)
    : await enforceIdentified("api_v1", key.keyId, DEFAULT_LIMITS.api_v1);
  if (limited) return { ok: false, response: limited };

  // 5. Audit — the request is admitted; record it (metadata only, best-effort).
  await logApiRequest(key, request, ADMITTED_STATUS);

  return { ok: true, key };
}

export async function guardPublicJobsRequest(
  request: Request,
): Promise<GuardResult> {
  // 1. Flag — dark ⇒ 404, before we even look at the credential.
  if (!isPublicApiJobsEnabled()) return { ok: false, response: notFound() };

  // 2. Auth.
  const key = await resolveApiKey(request.headers.get("authorization"));
  if (!key) return { ok: false, response: unauthorized() };

  // 3. Scope.
  if (!hasScope(key.scopes, "read:jobs")) {
    return { ok: false, response: forbidden() };
  }

  // 4. Rate limit — AFTER resolution, keyed by the key id (see DEFAULT_LIMITS
  //    .api_v1). The 401/403 paths above stay un-metered but are cheap. Jobs is
  //    a READ surface, so it metres fail-open like every other read.
  const limited = await enforceIdentified(
    "api_v1",
    key.keyId,
    DEFAULT_LIMITS.api_v1,
  );
  if (limited) return { ok: false, response: limited };

  // 5. Audit — the request is admitted; record it (metadata only, best-effort).
  await logApiRequest(key, request, ADMITTED_STATUS);

  return { ok: true, key };
}
