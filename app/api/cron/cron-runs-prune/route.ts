import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { pruneCronRuns } from "@/server/services/cron-runs-prune";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * GET /api/cron/cron-runs-prune — daily ops-telemetry retention pass.
 *
 * Bounds the growth of `public.cron_runs`, which had never been pruned and had
 * become ~70% of the production database. Deletes successful runs past the
 * 14-day horizon and failures past 90 days, in bounded batches (see
 * server/services/cron-runs-prune.ts and migration 20261213000000).
 *
 * Deliberately NOT folded into /api/cron/retention-purge: that route runs
 * per-org TENANT data policies under a feature flag and a dry-run default.
 * Platform telemetry is a different concern with a different safety model, and
 * conflating them would put customer-data deletion and ops housekeeping behind
 * one switch.
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

  const { status, payload } = await withCronTelemetry("cron-runs-prune", async () => {
    const summary = await pruneCronRuns();
    return { ok: summary.ok, summary };
  });
  return NextResponse.json(payload, { status });
}
