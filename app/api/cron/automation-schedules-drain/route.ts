import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { drainDueSchedules } from "@/server/services/automation-schedules";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * Automation OS — time-triggered schedule drain (20261096).
 *
 *   GET /api/cron/automation-schedules-drain
 *
 * Vercel cron hits this every minute (schedule in vercel.json). It fires every
 * schedule whose next_run_at has passed, dispatches the bound rule ORG-SCOPED
 * through the shared automation dispatcher, and advances next_run_at to the next
 * deterministic occurrence.
 *
 * SAFE + IDEMPOTENT. Two overlapping ticks cannot double-fire an occurrence: the
 * drain advances next_run_at with an optimistic per-schedule claim (update ...
 * where next_run_at = <observed>), and the dispatch itself carries an
 * occurrence-scoped correlation id guarded by the engine's atomic (rule_id,
 * correlation_id) claim. Cross-tenant-safe: each schedule dispatches with its
 * OWN org_id, so a schedule can only ever act inside its own organisation.
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
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;

  const { status, payload } = await withCronTelemetry(
    "automation-schedules-drain",
    async () => {
      const summary = await drainDueSchedules(new Date(), limit);
      return { ok: true, ...summary };
    },
  );
  return NextResponse.json(payload, { status });
}
