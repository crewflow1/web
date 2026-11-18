import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCapabilityApi } from "@/server/auth/capabilities";
import { askAi } from "@/server/services/ai-question";
import { DEFAULT_LIMITS, enforceIdentifiedStrict } from "@/lib/security/rate-limit";

/**
 * POST /api/ai/question
 *
 * Tenant-side endpoint for the AI question box on /insights.
 * Reads-only — returns an `AiResponse` (answer + confidence + sources).
 *
 * Auth: requireCapabilityApi("reports","view") — the answer is built from a
 * financial snapshot, so it inherits the same data-visibility boundary as
 * /insights and /reports. RLS-scoped data is fetched server-side via the
 * existing retention snapshot on the user JWT. Cross-org data leakage is
 * impossible.
 *
 * Rate limit: 20 questions per USER per hour, counted in the DURABLE shared
 * store (Postgres `rate_limit_hit`) and FAIL-CLOSED. It was a per-IP counter
 * held in each lambda instance's memory: instances do not share it, an office
 * behind one NAT did, and a signed-in caller looping the route was limited only
 * by how many instances answered. Keyed on the authenticated user — the thing
 * that actually spends — it holds across cold starts and cannot be dodged by
 * changing IP. The governor adds its own per-org/per-user velocity limit and
 * the monthly ceiling underneath (lib/ai/governor/velocity.ts).
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
  // The AI answer is built from a snapshot carrying invoiced totals/counts, so
  // this inherits the SAME data-visibility boundary as /insights and /reports:
  // reports:view. (AI inherits the requesting user's permission to the data;
  // the cost governor caps spend separately.) Owner always; admin with the
  // grant; staff/members denied.
  const guard = await requireCapabilityApi("reports", "view");
  // The 403 is a plain Response; this route's signature is NextResponse.
  if (guard instanceof Response) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const { ctx, user } = guard;

  // 20 per USER per hour, durable + fail-closed (see the header note). AFTER the
  // capability guard on purpose: the identifier is the authenticated user, and
  // an unauthorised caller must not be able to spend another user's allowance.
  const rl = await enforceIdentifiedStrict(
    "ai_question",
    `${ctx.org.id}:${user.id}`,
    DEFAULT_LIMITS.ai_question,
  );
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
      userId: user.id,
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
