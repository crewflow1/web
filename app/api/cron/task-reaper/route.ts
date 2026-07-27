import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { reapTasks } from "@/server/services/hq-tasks";
import { emitEvent } from "@/server/services/event-spine";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * CrewFlow HQ — Generic Task Engine reaper (CEO Directive #012 / D-02, PR-C).
 *
 *   GET /api/cron/task-reaper
 *
 * Crash recovery for the durable queue. A worker that claims a task stamps a
 * lease; if it dies (browser closed, invocation killed, deploy mid-run) the lease
 * expires and the task is stranded in 'running'. This cron is the net that frees
 * it: `hq_ai_task_reap` recovers every running row whose `lease_expires_at` has
 * passed, treating each as a retryable failure (re-queued with backoff if retries
 * remain, else terminally failed). It reaps across ALL task types, bounded per
 * invocation so one run can never run away.
 *
 * It is a SYSTEM actor, deliberately SEPARATE from employee runners (CEO decision
 * 4): recovery is the platform's job, not any one employee's, so a dead worker is
 * never the thing that has to notice it died. The task.retried / task.failed spine
 * events are emitted INSIDE the entry point (PR-B); this route emits only its own
 * `system.cron_ran` telemetry, and only when it actually recovered something —
 * the spine records meaningful facts, not per-tick liveness (the same restraint
 * that keeps heartbeats off the spine, ADR-0005).
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;

  const { status, payload } = await withCronTelemetry("task-reaper", async () => {
    const res = await reapTasks(null, limit);
    if (!res.ok) {
      return { ok: false, error: res.error };
    }

    // Emit the reaper's own telemetry ONLY when it recovered tasks — a real fact
    // ("N stranded tasks were recovered"), not liveness chatter. The lifecycle
    // events themselves (task.retried / task.failed) already fired in-transaction.
    if (res.reaped > 0) {
      await emitEvent({
        actorType: "system",
        actorId: "task-reaper",
        verb: "system.cron_ran",
        objectType: "cron",
        objectId: "task-reaper",
        severity: "info",
        payload: { reaped: res.reaped },
      });
    }

    return { ok: true, reaped: res.reaped };
  });

  return NextResponse.json(payload, { status });
}
