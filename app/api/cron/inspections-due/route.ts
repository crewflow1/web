import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import { runInspectionGenerator } from "@/server/services/asset-inspection-generator";

/**
 * M4b-2 — due-inspection generator.
 *
 *   GET /api/cron/inspections-due
 *
 * Vercel cron hits this daily (schedule in vercel.json). Scans active
 * inspection schedules inside their lead window and generates each cycle's due
 * inspection — a draft asset_inspection carrying the frozen snapshot of the
 * template family's CURRENT PUBLISHED version.
 *
 * Idempotency story: the INSERT is the claim — ON CONFLICT (schedule_id,
 * cycle_key) DO NOTHING — so repeated, concurrent and retried runs converge on
 * exactly one due inspection per cycle; schedule advancement is a count-gated
 * CAS on next_due. Cron timing is never load-bearing.
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
  const { status, payload } = await withCronTelemetry("inspections-due", async () => {
    const summary = await runInspectionGenerator();
    return { ok: true, summary };
  });
  return NextResponse.json(payload, { status });
}
