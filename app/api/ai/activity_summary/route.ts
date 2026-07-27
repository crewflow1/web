import { NextResponse, type NextRequest } from "next/server";
import { requireOrgContext } from "@/server/auth/session";
import { computeActivitySummary } from "@/lib/ai/aggregates";
import { resolveInsightNarrative } from "@/server/services/ai-insights";

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
 * Flow:
 *   1. Compute the deterministic metrics (RLS-scoped under the user JWT) —
 *      these are the authoritative product output, always intact.
 *   2. Resolve the prose narrative through the ONE shared funnel
 *      (`resolveInsightNarrative` → `lib/ai/text` provider abstraction): cache
 *      lookup, then (on miss) a narrate-only generation, cached + cost-recorded.
 *   3. On no provider / failure the summary is null and cache "disabled"; the
 *      deterministic body is unchanged.
 *
 * Privacy: `org_id` is used only in the server-side KV cache key; the generator
 * strips it before any model sees the payload. Every metric derives from
 * RLS-scoped queries — no PII beyond what org members already see.
 */

export async function GET(request: NextRequest) {
  const { ctx } = await requireOrgContext();
  const url = request.nextUrl;
  const rawWindow = parseInt(url.searchParams.get("window") ?? "7", 10);
  const windowDays = Math.max(1, Math.min(Number.isFinite(rawWindow) ? rawWindow : 7, 90));

  const payload = await computeActivitySummary(ctx.org.id, windowDays);

  const { summary, cache } = await resolveInsightNarrative({
    orgId: ctx.org.id,
    kind: "activity",
    windowDays,
    payload,
  });
  payload.summary = summary;
  payload.cache = cache;

  return NextResponse.json(payload);
}
