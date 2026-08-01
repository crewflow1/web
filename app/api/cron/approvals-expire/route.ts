import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { expireDueApprovals } from "@/server/services/hq-approvals";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * CrewFlow HQ — Approval Engine expiry sweep (Train 11).
 *
 *   GET /api/cron/approvals-expire
 *
 * The Approval Engine shipped expiry as a callable primitive
 * (expireDueApprovals) and Phase 2 deliberately left it unwired. That left a
 * hole: a pending approval with a passed deadline sat in the queue forever,
 * silently misrepresenting itself as still decidable. Now that the human
 * decision surface exists (/admin/approvals), the deadline becomes real: this
 * cron sweeps every active approval whose expires_at has passed into the
 * `expired` terminal state, bounded per invocation.
 *
 * The sweep is a SYSTEM act — expiry needs no reviewer, and the DB trigger
 * emits the `approval.expired` spine event inside each transition, so this
 * route adds no audit vocabulary of its own. Every 15 minutes (matching the
 * notifications-drain / memory-lifecycle cadence): approvals carry
 * day-scale deadlines, so minute-scale sweeping would be noise.
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

  const { status, payload } = await withCronTelemetry("approvals-expire", async () => {
    const res = await expireDueApprovals(undefined, limit);
    return { ok: res.ok, expired: res.expired };
  });

  return NextResponse.json(payload, { status });
}
