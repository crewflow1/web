import { NextResponse, type NextRequest } from "next/server";
import { requireOrgContext } from "@/server/auth/session";
import { computeLeadInsights } from "@/lib/ai/aggregates";
import { maybeGenerateSummary } from "@/lib/ai/llm";

/**
 * GET /api/ai/lead_insights?window=30
 *
 * Deterministic conversion analytics across the lead pipeline.
 * `summary` is null until the LLM lights up.
 */
export async function GET(request: NextRequest) {
  const { ctx } = await requireOrgContext();
  const url = request.nextUrl;
  const rawWindow = parseInt(url.searchParams.get("window") ?? "30", 10);
  const windowDays = Math.max(1, Math.min(Number.isFinite(rawWindow) ? rawWindow : 30, 365));

  const payload = await computeLeadInsights(ctx.org.id, windowDays);
  // Phase 5 prep: LLM-prose hook. No-op when no key is set.
  const { org_id: _strippedOrgId, ...promptInput } = payload;
  void _strippedOrgId;
  payload.summary = await maybeGenerateSummary("lead", promptInput);
  return NextResponse.json(payload);
}
