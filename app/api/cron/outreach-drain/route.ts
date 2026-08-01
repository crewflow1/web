import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { drainOutreachTasks } from "@/server/services/hq-outreach";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * CrewFlow HQ — Outreach AI drain (CEO Directive 010, Phase 4 safety net).
 *
 *   GET /api/cron/outreach-drain
 *
 * The live "Draft outreach" flow kicks each run from the browser as soon as the
 * task is enqueued, so most runs never reach this cron. This is the guarantee that
 * nothing is ever lost: it picks up `generate_email` tasks that were enqueued but
 * never kicked (browser closed, request dropped) and drains them through the
 * generic Task Engine. Crash recovery is no longer this cron's job — a claim takes
 * a time-boxed lease and the separate task-reaper cron recovers anything whose
 * lease expired (Directive #012 / D-02). Bounded per invocation so one drain can
 * never run away.
 *
 * EXECUTION STAYS LOCKED: the drain claims → drafts (governed + DARK ⇒ deterministic
 * fallback with no cost tier bound) → completes. It sends nothing; the draft is the
 * terminal artifact, awaiting human approval (the V1 Draft → Review → Approve → Send
 * contract).
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A drain may run up to three drafts back to back; give it the full budget for a
// cold lambda (the DARK deterministic leg is fast, but a bound tier would not be).
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5) : 3;

  const { status, payload } = await withCronTelemetry("outreach-drain", async () => {
    const summary = await drainOutreachTasks(limit);
    return { ok: summary.ok, summary };
  });
  return NextResponse.json(payload, { status });
}
