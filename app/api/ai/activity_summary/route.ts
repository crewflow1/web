import { NextResponse, type NextRequest } from "next/server";
import { requireOrgContext } from "@/server/auth/session";
import { computeActivitySummary } from "@/lib/ai/aggregates";

/**
 * GET /api/ai/activity_summary?window=7
 *
 * Deterministic-only response — no LLM call. `summary` returns null
 * as a placeholder; the prose slot fills in once an Anthropic/OpenAI
 * key lands in Vercel and a follow-up PR lights up the inference path.
 *
 * Window defaults to 7 days; capped at 90 to bound the underlying scan.
 */
export async function GET(request: NextRequest) {
  const { ctx } = await requireOrgContext();
  const url = request.nextUrl;
  const rawWindow = parseInt(url.searchParams.get("window") ?? "7", 10);
  const windowDays = Math.max(1, Math.min(Number.isFinite(rawWindow) ? rawWindow : 7, 90));

  const payload = await computeActivitySummary(ctx.org.id, windowDays);
  return NextResponse.json(payload);
}
