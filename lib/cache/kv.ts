import "server-only";
import { kv } from "@vercel/kv";

/**
 * Thin wrapper around @vercel/kv (Upstash Redis under the hood).
 *
 * Why a wrapper:
 *   1. Centralises the "no KV configured" guard. In local dev or CI the
 *      KV env vars may be absent; calls should silently behave as a
 *      cache miss + no-op write, never throw.
 *   2. Single typing point — every cache value is JSON, so we encode/
 *      decode through `unknown` rather than scattering `as` casts.
 *   3. Single TTL surface, expressed in hours for readability.
 *
 * KV access is server-side only — the Upstash token never reaches the
 * client. RLS doesn't apply to Redis; org scoping lives in the cache
 * key itself (callers MUST include org_id in the key).
 */

const KV_ENV_KEYS = [
  "KV_REST_API_URL",
  "KV_REST_API_TOKEN",
] as const;

export function isKvConfigured(): boolean {
  return KV_ENV_KEYS.every((k) => !!process.env[k]);
}

/**
 * Fetch a cached JSON value. Returns null on miss or any error.
 *
 * Errors are swallowed by design — a cache fault must never break the
 * end-user request. Caller falls through to compute + write.
 */
export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!isKvConfigured()) return null;
  try {
    const v = await kv.get<T>(key);
    return v ?? null;
  } catch (err) {
    console.error("[cache] get failed", { key, err });
    return null;
  }
}

/**
 * Write a JSON value with a TTL in hours.
 *
 * Returns true if the write succeeded, false otherwise. Callers can
 * ignore the return value — failure is non-fatal — but the boolean is
 * useful for the QA / cache-status response field.
 */
export async function cacheSet(
  key: string,
  value: unknown,
  ttlHours: number,
): Promise<boolean> {
  if (!isKvConfigured()) return false;
  try {
    const ttlSeconds = Math.max(1, Math.round(ttlHours * 3600));
    await kv.set(key, value, { ex: ttlSeconds });
    return true;
  } catch (err) {
    console.error("[cache] set failed", { key, err });
    return false;
  }
}

/**
 * Build a namespaced cache key.
 *
 * Convention:  <namespace>:<org_id>:<scope>:<window_days>
 * Examples:
 *   ai:activity_summary:82448b20-…:7
 *   ai:lead_insights:82448b20-…:30
 *
 * The org_id is the only piece of org-identifiable data that touches
 * KV. The prompt payload sent to the LLM strips this — KV is gated by
 * server-only credentials so the key shape is acceptable.
 */
export function buildCacheKey(parts: string[]): string {
  return parts.filter(Boolean).join(":");
}
