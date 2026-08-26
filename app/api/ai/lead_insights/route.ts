import { NextResponse, type NextRequest } from "next/server";
import { requireManagementApi } from "@/server/auth/session";
import { computeLeadInsights } from "@/lib/ai/aggregates";
import { resolveInsightNarrative } from "@/server/services/ai-insights";

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
 * Same flow as /api/ai/activity_summary — see that route for the detailed
 * comment block. Differences:
 *   - default window: 30 days (vs 7)
 *   - narrative kind: "lead"
 */

export async function GET(request: NextRequest) {
  // Sales-area insight data — management-only (fix 1).
  const guard = await requireManagementApi();
  if (guard instanceof Response) return guard;
  const { ctx } = guard;
  const url = request.nextUrl;
  const rawWindow = parseInt(url.searchParams.get("window") ?? "30", 10);
  const windowDays = Math.max(1, Math.min(Number.isFinite(rawWindow) ? rawWindow : 30, 365));

  const payload = await computeLeadInsights(ctx.org.id, windowDays);

  const { summary, cache } = await resolveInsightNarrative({
    orgId: ctx.org.id,
    kind: "lead",
    windowDays,
    payload,
  });
  payload.summary = summary;
  payload.cache = cache;

  return NextResponse.json(payload);
}
