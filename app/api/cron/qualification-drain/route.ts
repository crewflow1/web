import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { drainQualificationTasks } from "@/server/services/hq-qualification";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * CrewFlow HQ — Lead Qualification drain (CEO Directive 003, Module 3 safety net).
 *
 *   GET /api/cron/qualification-drain
 *
 * The live "Qualify" flow kicks each run from the browser as soon as the task
 * is enqueued, so most runs never reach this cron. This is the guarantee that
 * nothing is ever lost: it picks up tasks that were enqueued but never kicked
 * (browser closed, request dropped) and drains them through the generic Task
 * Engine. Crash recovery is no longer this cron's job — a claim takes a
 * time-boxed lease and the separate task-reaper cron recovers anything whose
 * lease expired (Directive #012 / D-02, PR-F). Bounded per invocation so one
 * drain can never run away.
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A drain may run up to three deterministic tasks back to back — fast, but keep
// the full budget for a cold lambda.
export const maxDuration = 30;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5) : 3;

  const { status, payload } = await withCronTelemetry("qualification-drain", async () => {
    const summary = await drainQualificationTasks(limit);
    return { ok: summary.ok, summary };
  });
  return NextResponse.json(payload, { status });
}
