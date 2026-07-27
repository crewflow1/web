import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { ensureSpinePartitions } from "@/server/services/event-spine";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * CrewFlow HQ — Event Spine partition maintenance (Module 1, PR1).
 *
 *   GET /api/cron/spine-partitions
 *
 * Keeps `hq_events` partitioned ~2 months ahead of need (Ch.03). Idempotent:
 * creates only the months that don't yet exist, so running it daily is cheap and
 * the DEFAULT catch-all partition stays empty in normal operation. Bounded to a
 * few RPC calls per run.
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { status, payload } = await withCronTelemetry("spine-partitions", async () => {
    const summary = await ensureSpinePartitions(2);
    return { ok: summary.ok, summary };
  });
  return NextResponse.json(payload, { status });
}
