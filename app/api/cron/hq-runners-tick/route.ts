import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import {
  enqueueAnalyticsSnapshot,
  drainAnalyticsTasks,
} from "@/server/services/hq-analytics-runner";
import {
  enqueueMonitoringSweep,
  drainMonitoringTasks,
} from "@/server/services/hq-monitoring-runner";
import {
  enqueueNotificationDigest,
  drainNotificationTasks,
} from "@/server/services/hq-notification-runner";

/**
 * CrewFlow HQ — Roster runners tick (MP Wave R3).
 *
 *   GET /api/cron/hq-runners-tick
 *
 * Drives the deterministic roster runners (analytics-ai, monitoring-incident-ai,
 * notification-ai) on the generic Task Engine. Each tick ENQUEUES one fresh task per
 * runner (deduped per period, so a re-tick never piles up a backlog) and then DRAINS the
 * ready tasks through the canonical runner SDK — so the Boardroom cards for these
 * employees populate from real `hq_ai_tasks` rows rather than reading "insufficient".
 *
 * Every runner is DETERMINISTIC and side-effect-free: it COMPUTES and REPORTS over real
 * data sources and completes a task with an explainable, sourced result. Nothing here
 * sends, commits, or mutates — humans keep final approval.
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise. Best-effort: a single
 * runner's failure is captured in its section of the summary rather than failing the
 * whole tick.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Enqueue + drain up to three runners back to back — give it the full budget.
export const maxDuration = 60;

async function safe<T>(label: string, fn: () => Promise<T>): Promise<T | { ok: false; error: string }> {
  try {
    return await fn();
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`[hq-runners-tick] ${label} failed`, error);
    return { ok: false, error };
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { status, payload } = await withCronTelemetry("hq-runners-tick", async () => {
    const now = new Date();

    const analytics = await safe("analytics", async () => {
      const enqueued = await enqueueAnalyticsSnapshot(now);
      const drained = await drainAnalyticsTasks();
      return { enqueued, drained };
    });

    const monitoring = await safe("monitoring", async () => {
      const enqueued = await enqueueMonitoringSweep(now);
      const drained = await drainMonitoringTasks();
      return { enqueued, drained };
    });

    const notification = await safe("notification", async () => {
      const enqueued = await enqueueNotificationDigest(now);
      const drained = await drainNotificationTasks();
      return { enqueued, drained };
    });

    return { ok: true, analytics, monitoring, notification };
  });

  return NextResponse.json(payload, { status });
}
