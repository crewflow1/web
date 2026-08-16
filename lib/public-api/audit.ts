import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ResolvedApiKey } from "@/lib/api-auth/resolve";

/**
 * Public API v1 — the per-request ACCESS LOG writer.
 *
 * The guard (lib/public-api/guard.ts) previously made only the "per-endpoint
 * audit" claim without meeting it: the sole per-key telemetry was a coarse,
 * once-a-minute debounced last_used_at touch on api_keys. This module is the
 * real audit trail — one row in `api_request_log` (migration
 * 20261168000000) per ADMITTED v1 request, written from the guard through the
 * service-role admin client (RLS admin-only read, no tenant write).
 *
 * METADATA ONLY — a HARD boundary. The row carries the HTTP method, the request
 * URL PATHNAME, and the guard's disposition status. It NEVER carries a request
 * body, a header, or the query string:
 *   - the body is where secrets/PII live, so it is never touched here;
 *   - the query string can carry pagination/filter values that name tenant
 *     rows, so it is stripped (only `url.pathname` is stored, and the DB CHECK
 *     forbids a '?' as a second line of defence).
 * The api_keys secret itself is never in scope — the guard has already resolved
 * the key to an opaque id by the time this runs.
 *
 * WHY ADMITTED-ONLY (and why this is bounded, not a DoS amplifier). The guard
 * logs a request only AFTER it passes auth + scope + rate-limit, so:
 *   - every logged request is authenticated (a real key, a real org) — this is
 *     an access log, not an anonymous-traffic log;
 *   - the volume is capped by the rate limiter itself (≤120 rows/min/key), so a
 *     flood cannot amplify into unbounded audit writes. Pre-admission denials
 *     (401/403/429) deliberately write NOTHING here: a 403/429 accessed no data
 *     and the abuse signal already lives in rate_limit_counters + the resolver's
 *     error logs.
 *
 * BEST-EFFORT, LIKE last_used_at. Telemetry must never break a request that the
 * guard already admitted: any failure is logged and swallowed. It is awaited
 * (serverless can freeze out a dangling write) but can neither throw nor block.
 */

/** Minimal typed insert surface — api_request_log post-dates the generated
 *  Database types (the house `as never` idiom for new tables). */
type ApiRequestLogInsert = {
  insert: (row: {
    key_id: string;
    org_id: string;
    method: string;
    route: string;
    status: number;
  }) => Promise<{ error: { message?: string | null } | null }>;
};

/**
 * Record ONE admitted public-API request. `status` is the disposition the guard
 * is about to hand back to the handler (200 for an admitted request). Never
 * throws.
 */
export async function logApiRequest(
  key: ResolvedApiKey,
  request: Request,
  status: number,
): Promise<void> {
  try {
    // PATHNAME ONLY — never the query string (see module header).
    let route: string;
    try {
      route = new URL(request.url).pathname;
    } catch {
      // A malformed URL should never happen on a served route, but never let it
      // break the log write.
      route = "/api/v1";
    }
    // Bound the stored route defensively (the column CHECK caps it at 300).
    if (route.length > 300) route = route.slice(0, 300);

    const method = (request.method || "GET").toUpperCase();

    const admin = createAdminClient();
    const { error } = await (
      admin.from("api_request_log" as never) as unknown as ApiRequestLogInsert
    ).insert({
      // ORG + KEY pinning — from the RESOLVED key, never client input.
      key_id: key.keyId,
      org_id: key.orgId,
      method,
      route,
      status,
    });
    if (error) {
      console.error("[public-api] request-log write failed", error.message);
    }
  } catch (e) {
    // Audit telemetry must never break an admitted request.
    console.error(
      "[public-api] request-log write threw",
      e instanceof Error ? e.message : String(e),
    );
  }
}
