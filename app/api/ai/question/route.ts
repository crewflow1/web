import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOrgContext } from "@/server/auth/session";
import { askAi } from "@/server/services/ai-question";
import { DEFAULT_LIMITS, enforce } from "@/lib/security/rate-limit";

/**
 * POST /api/ai/question
 *
 * Tenant-side endpoint for the AI question box on /insights.
 * Reads-only — returns an `AiResponse` (answer + confidence + sources).
 *
 * Auth: requireOrgContext (user JWT + active membership). RLS-scoped
 * data is fetched server-side via the existing retention snapshot,
 * which uses the same JWT. Cross-org data leakage is impossible.
 *
 * Rate limit story: deferred to Phase 7 (security). For now the
 * Claude/OpenAI provider's own rate limits + a request timeout cap
 * abuse cost.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  question: z
    .string()
    .trim()
    .min(3, "Question must be at least 3 characters.")
    .max(500, "Question is too long — keep it under 500 characters."),
});

export async function POST(request: Request): Promise<NextResponse> {
  const { ctx } = await requireOrgContext();

  // Phase 7 — rate limit AI questions: 20 per IP per hour. Caps
  // LLM cost on abuse + keeps the request cheap.
  const rl = enforce(request, "ai_question", DEFAULT_LIMITS.ai_question);
  if (rl) return rl as unknown as NextResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Bad request body" },
      { status: 400 },
    );
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Invalid input",
      },
      { status: 422 },
    );
  }

  try {
    const response = await askAi({
      orgId: ctx.org.id,
      question: parsed.data.question,
    });
    return NextResponse.json({ ok: true, response });
  } catch (e) {
    console.error("[api/ai/question] failed", e);
    return NextResponse.json(
      {
        ok: false,
        error: "Something went wrong building your answer. Try again.",
      },
      { status: 500 },
    );
  }
}
