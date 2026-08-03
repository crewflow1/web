import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { tickCadences } from "@/server/services/hq-cadence";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * CrewFlow HQ — the operating-model cadence-clock tick (migration 20261108).
 *
 *   GET /api/cron/hq-cadence-tick
 *
 * Vercel cron hits this every minute (schedule in vercel.json). It fires every
 * ENABLED cadence in the schedule registry (hq_ai_schedules) whose next_run_at
 * has passed, ROUTING each to its EXISTING HQ authority (the same drain the
 * legacy cron calls), and advances next_run_at to the next deterministic
 * occurrence via the shared UTC evaluator (lib/automation/cron computeNextRun).
 *
 * SAFE + IDEMPOTENT. Two overlapping ticks cannot double-fire an occurrence: each
 * cadence is claimed with an optimistic next_run_at CAS (update ... where
 * next_run_at = <observed>), so only the winning tick dispatches this occurrence.
 *
 * DARK BY DEFAULT. Every seeded cadence ships enabled=false, so this tick is inert
 * until a super-admin opts a cadence in from /admin/hq-cadence. The legacy crons
 * keep firing unchanged — this is an additive modelling layer, not a replacement.
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// An enabled cadence routes to a real drain that may run several tasks back to
// back; give the tick the full budget for a cold lambda.
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 50;

  const { status, payload } = await withCronTelemetry("hq-cadence-tick", async () => {
    const summary = await tickCadences({ now: new Date(), limit });
    return { ok: true, ...summary };
  });
  return NextResponse.json(payload, { status });
}
