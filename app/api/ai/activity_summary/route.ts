import { NextResponse, type NextRequest } from "next/server";
import { requireOrgContext } from "@/server/auth/session";
import { computeActivitySummary } from "@/lib/ai/aggregates";
import { maybeGenerateSummary } from "@/lib/ai/llm";
import { buildCacheKey, cacheGet, cacheSet, isKvConfigured } from "@/lib/cache/kv";
import type { CacheStatus } from "@/lib/ai/types";

/**
 * GET /api/ai/activity_summary?window=7
 *
 * Response shape (always):
 *   {
 *     org_id, window_days,
 *     summary: string | null,
 *     cache: "hit" | "miss" | "disabled",
 *     action_counts, daily_volume, key_metrics, stalled_actions
 *   }
 *
 * Phase 6 flow:
 *   1. Compute deterministic metrics (RLS-scoped under user JWT).
 *   2. Build cache key including org + ISO date + window.
 *   3. Cache lookup. If hit → return with cache: "hit".
 *   4. Otherwise call LLM (max 8s). Strip org_id from prompt input.
 *   5. On success → write to KV with 24h TTL → cache: "miss".
 *   6. On LLM failure / no key / KV disabled → summary stays null,
 *      cache: "disabled". Deterministic body is always intact.
 *
 * Privacy:
 *   - org_id is stripped from the LLM prompt input (never reaches
 *     Anthropic/OpenAI). It's part of the KV cache key only — KV is
 *     server-side, token-gated, never exposed to clients.
 *   - All deterministic metrics derive from RLS-scoped queries; no
 *     PII beyond what's already visible to org members.
 */

const CACHE_TTL_HOURS = 24;
const KV_NAMESPACE = "ai:activity";

export async function GET(request: NextRequest) {
  const { ctx } = await requireOrgContext();
  const url = request.nextUrl;
  const rawWindow = parseInt(url.searchParams.get("window") ?? "7", 10);
  const windowDays = Math.max(1, Math.min(Number.isFinite(rawWindow) ? rawWindow : 7, 90));

  const payload = await computeActivitySummary(ctx.org.id, windowDays);

  // Cache key includes the day-bucket so summaries roll over at UTC midnight.
  const today = new Date().toISOString().slice(0, 10);
  const cacheKey = buildCacheKey([KV_NAMESPACE, ctx.org.id, today, String(windowDays)]);

  if (isKvConfigured()) {
    const cached = await cacheGet<string>(cacheKey);
    if (cached) {
      payload.summary = cached;
      payload.cache = "hit" as CacheStatus;
      return NextResponse.json(payload);
    }
  }

  // Strip org_id before the LLM sees the prompt input.
  const { org_id: _strippedOrgId, ...promptInput } = payload;
  void _strippedOrgId;
  const summary = await maybeGenerateSummary("activity", promptInput);

  if (summary) {
    payload.summary = summary;
    const written = await cacheSet(cacheKey, summary, CACHE_TTL_HOURS);
    payload.cache = (written ? "miss" : "disabled") as CacheStatus;
  } else {
    payload.summary = null;
    payload.cache = "disabled" as CacheStatus;
  }

  return NextResponse.json(payload);
}
