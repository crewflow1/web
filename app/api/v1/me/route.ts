import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/api-auth/resolve";
import { DEFAULT_LIMITS, enforceIdentified } from "@/lib/security/rate-limit";

/**
 * GET /api/v1/me — the API-key substrate's LIVING PROOF, not a product
 * surface (Train 9).
 *
 * This is the one and only public-API endpoint, and it exists so the
 * substrate is verifiable end-to-end: mint a key in /settings/api-keys, curl
 * this route with `Authorization: Bearer crewflow_sk_…`, and see exactly the
 * identity the key carries. It reads NO tenant data — jobs, customers,
 * invoices etc. are deliberately unreachable until a product API surface is
 * approved (CEO decision, out of this train's authority).
 *
 * Contract:
 *   - 401 on missing / malformed / unknown / REVOKED / EXPIRED key —
 *     resolveApiKey is the single authority and re-checks revocation +
 *     expiry against Postgres on EVERY call (no caching).
 *   - 429 once a key exceeds DEFAULT_LIMITS.api_v1 (120/min, keyed by KEY
 *     ID, not IP — see the pin comment in lib/security/rate-limit.ts,
 *     including the deliberate fail-open inheritance).
 *   - 200 returns ONLY { org_id, key_prefix, scopes }. Never the hash,
 *     never the key id, never names or any tenant row.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UNAUTHORIZED = () =>
  NextResponse.json(
    { ok: false, error: "invalid_api_key" },
    {
      status: 401,
      // RFC 6750 — tell well-behaved clients which scheme this surface wants.
      headers: { "www-authenticate": 'Bearer realm="crewflow-api"' },
    },
  );

export async function GET(request: Request): Promise<Response> {
  const key = await resolveApiKey(request.headers.get("authorization"));
  if (!key) return UNAUTHORIZED();

  // Rate limit AFTER resolution, because the identifier IS the key id: a
  // per-key budget no shared office NAT can eat and no IP rotation can dodge.
  // The 401 path above stays un-metered but is a single indexed lookup.
  const limited = await enforceIdentified(
    "api_v1",
    key.keyId,
    DEFAULT_LIMITS.api_v1,
  );
  if (limited) return limited;

  // The three safe fields, and nothing else.
  return NextResponse.json({
    org_id: key.orgId,
    key_prefix: key.keyPrefix,
    scopes: key.scopes,
  });
}
