import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOrgContext } from "@/server/auth/session";
import { answerSiteManager } from "@/server/services/site-manager/orchestrator";
import { DEFAULT_LIMITS, enforce } from "@/lib/security/rate-limit";

/**
 * POST /api/ai/site-manager
 *
 * The AI Site Manager answer endpoint. Unlike /api/ai/question (which is
 * financials-only and gated on reports:view), the Site Manager answers
 * site-level questions about ONE job — diary, snags, materials, progress — so
 * it is open to ANY authenticated org member. It is NOT gated on a capability:
 * a staff member on the job may use it.
 *
 * The data boundary is enforced DEEPER than the route, by the tools the
 * orchestrator runs:
 *   - every reader runs on the user JWT, so RLS (`current_org_ids()` +
 *     `my_assigned_job_ids()`) fail-closes org + assignment scope — a staff
 *     caller physically cannot read an unassigned job;
 *   - the financial tool adds the owner/admin role gate and returns
 *     `{ unauthorised:true }` (never a number) for everyone else.
 * The SERVER classifies intent and selects the tool, so adversarial text inside
 * a job's notes can never pick a tool, widen scope, or request a write.
 *
 * Reads-only. Returns an `AiResponse` (answer + confidence + sources). While the
 * `high` inference tier is dark the deterministic lane answers (no model, no
 * cost); the governor caps spend when the tier is armed.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  question: z
    .string()
    .trim()
    .min(3, "Question must be at least 3 characters.")
    .max(500, "Question is too long — keep it under 500 characters."),
  jobId: z.string().uuid("Invalid job id.").nullish(),
});

export async function POST(request: Request): Promise<NextResponse> {
  // Any authenticated member — the tools (RLS + role gate) decide what data the
  // caller may actually see. An unauthenticated request never reaches here: the
  // middleware guards /api/ai/* (not in its exclusion matcher).
  const { user, ctx } = await requireOrgContext();

  // Rate limit: reuse the ai_question shape (20/hr) under its own bucket key so
  // the two AI surfaces don't share a budget. Caps LLM cost on abuse.
  const rl = enforce(request, "ai_site_manager", DEFAULT_LIMITS.ai_question);
  if (rl) return rl as unknown as NextResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Bad request body" }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" },
      { status: 422 },
    );
  }

  try {
    const response = await answerSiteManager({
      ctx: { org: { id: ctx.org.id }, membership: { role: ctx.membership.role } },
      user: { id: user.id },
      question: parsed.data.question,
      jobId: parsed.data.jobId ?? null,
    });
    return NextResponse.json({ ok: true, response });
  } catch (e) {
    console.error("[api/ai/site-manager] failed", e);
    return NextResponse.json(
      { ok: false, error: "Something went wrong building your answer. Try again." },
      { status: 500 },
    );
  }
}
