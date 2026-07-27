import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { getQualificationRunState } from "@/server/services/hq-qualification";

/**
 * CrewFlow HQ — Lead Qualification live state (CEO Directive 003, Module 3).
 *
 *   GET /api/admin/qualification/state/[taskId]
 *
 * The live run page polls this (~every 1.2s) while a run is in flight. It reads
 * the task's checkpointed `result` jsonb — phase, the per-step checklist, and
 * the final summary — so the UI can animate the engine working without any
 * websocket. Cheap by construction: one indexed row read plus the company name.
 *
 * Super-admin gated; 404 on miss. Always returns JSON so the client poller
 * never has to special-case a non-JSON body.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ taskId: string }> },
): Promise<NextResponse> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) {
    return NextResponse.json({ error: "not_authorised" }, { status: 404 });
  }

  const { taskId } = await params;
  if (!UUID_RE.test(taskId)) {
    return NextResponse.json({ error: "invalid_task_id" }, { status: 400 });
  }

  const state = await getQualificationRunState(taskId);
  if (!state) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true, state });
}
