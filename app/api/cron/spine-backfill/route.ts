import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { runBackfill, getBackfillStatus } from "@/server/services/spine-backfill";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * CrewFlow HQ — Event Spine historical backfill (Module 1, PR4).
 *
 *   GET /api/cron/spine-backfill
 *
 * The guaranteed-delivery path for the one-time historical replay (CEO decision
 * D2 — cron only, no LISTEN/NOTIFY). Each run drains every legacy source one
 * bounded batch: walk the next rows in deterministic (created_at, id) order, map
 * each to a canonical event, emit it through the (source, source_id) idempotency
 * guard carrying its original ts, and advance the per-source cursor in the same
 * transaction. Idempotent and safe to run as often as the schedule fires — a source
 * already 'done' is a no-op, and a re-run never duplicates an event.
 *
 * Ships DARK: short-circuits when `event_spine.backfill_enabled` is off, so until an
 * operator opts in this is a single cheap RPC. The run's `cron_runs` row records the
 * backfill progress (per-source status + counters) alongside what it drained.
 *
 * SCHEDULE: hourly, not per-minute. This is a ONE-TIME historical replay, and every
 * registered source in `hq_backfill_state` reached status='done' on 2026-08-16 — after
 * which a per-minute schedule spent ~1,440 runs a day (688 ms each) re-confirming that
 * a finished job was still finished. Hourly keeps the resume path for a newly
 * registered source without paying for a minute-resolution clock the work does not
 * need. The LIVE delivery path is /api/cron/spine-drain, which stays per-minute and is
 * deliberately untouched — this change moves a completed backfill, never a consumer.
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

  const { status, payload } = await withCronTelemetry("spine-backfill", async () => {
    const backfill = await runBackfill();
    // Progress is a cheap read; surface it so the cron run records each source's
    // status + counters (the backfill canary) alongside what it drained.
    const progress = backfill.enabled ? await getBackfillStatus() : null;
    return { ok: backfill.ok, backfill, progress };
  });
  return NextResponse.json(payload, { status });
}
