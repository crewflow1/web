import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import { runMaintenanceGenerator } from "@/server/services/asset-maintenance-generator";

/**
 * M5b — service-case generator.
 *
 *   GET /api/cron/maintenance-due
 *
 * Vercel cron hits this daily (schedule in vercel.json). Scans active service
 * schedules inside their lead window and generates each cycle's maintenance
 * case (status 'scheduled'). Idempotency: the INSERT is the claim — ON CONFLICT
 * (schedule_id, cycle_key) DO NOTHING — and advancement is a count-gated CAS,
 * so repeated, concurrent and retried runs converge on one case per cycle.
 * Cron timing is never load-bearing.
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
  const { status, payload } = await withCronTelemetry("maintenance-due", async () => {
    const summary = await runMaintenanceGenerator();
    return { ok: true, summary };
  });
  return NextResponse.json(payload, { status });
}
