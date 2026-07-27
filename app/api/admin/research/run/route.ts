import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { runResearchTask } from "@/server/services/hq-research";

/**
 * CrewFlow HQ — Research AI run kicker (CEO Directive 005, Phase 1).
 *
 *   POST /api/admin/research/run   body: { "taskId": "<uuid>" }
 *
 * The live run page calls this the moment it mounts: it claims the queued
 * research task and drives the whole pipeline (fetch → analyse → score →
 * reason) to completion. While it works, every step checkpoints the task's
 * `result` jsonb, so the page's poller (GET .../state/[taskId]) animates the
 * checklist in real time off the same row.
 *
 * runResearchTask is idempotent — claimTask only succeeds on a 'pending' row,
 * so a double-kick (browser retry + cron drain) is harmless: the loser gets a
 * `skipped` outcome. That's why this is safe to fire-and-forget from the UI.
 *
 * Super-admin gated; returns 404 on miss (no info leak). maxDuration covers a
 * cold run that makes two LLM calls plus the site fetch.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request): Promise<NextResponse> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) {
    return NextResponse.json({ error: "not_authorised" }, { status: 404 });
  }

  let taskId = "";
  try {
    const body = (await request.json()) as { taskId?: unknown };
    taskId = typeof body?.taskId === "string" ? body.taskId.trim() : "";
  } catch {
    // fall through to the validation error below
  }
  if (!UUID_RE.test(taskId)) {
    return NextResponse.json({ error: "invalid_task_id" }, { status: 400 });
  }

  const outcome = await runResearchTask(taskId);
  return NextResponse.json(outcome, { status: outcome.ok ? 200 : 500 });
}
