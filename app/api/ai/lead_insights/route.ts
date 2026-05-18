import { NextResponse, type NextRequest } from "next/server";
import { requireOrgContext } from "@/server/auth/session";
import { computeLeadInsights } from "@/lib/ai/aggregates";
import { maybeGenerateSummary } from "@/lib/ai/llm";
import { buildCacheKey, cacheGet, cacheSet, isKvConfigured } from "@/lib/cache/kv";
import type { CacheStatus } from "@/lib/ai/types";

/**
 * GET /api/ai/lead_insights?window=30
 *
 * Response shape (always):
 *   {
 *     org_id, window_days,
 *     summary: string | null,
 *     cache: "hit" | "miss" | "disabled",
 *     funnel, conversion_pct, source_close_rates, pipeline_forecast
 *   }
 *
 * Same flow as /api/ai/activity_summary — see that route for the
 * detailed comment block. Differences:
 *   - default window: 30 days (vs 7)
 *   - namespace: "ai:lead_insights"
 *   - prompt kind: "lead"
 */

const CACHE_TTL_HOURS = 24;
const KV_NAMESPACE = "ai:lead";

export async function GET(request: NextRequest) {
  const { ctx } = await requireOrgContext();
  const url = request.nextUrl;
  const rawWindow = parseInt(url.searchParams.get("window") ?? "30", 10);
  const windowDays = Math.max(1, Math.min(Number.isFinite(rawWindow) ? rawWindow : 30, 365));

  const payload = await computeLeadInsights(ctx.org.id, windowDays);

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
  const summary = await maybeGenerateSummary("lead", promptInput);

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
