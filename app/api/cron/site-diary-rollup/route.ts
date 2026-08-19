import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import { runSiteDiaryRollup } from "@/server/services/site-diary-rollup";

/**
 * Daily cron — automatic end-of-day Site Diary roll-up.
 *
 *   GET /api/cron/site-diary-rollup   (schedule in vercel.json)
 *
 * Composes ONE auto diary entry per ACTIVE job that had real activity on the UK
 * day that just ended — photos, snags raised/closed, goods received, and time on
 * site — plus a weather line when the provider is live. All logic lives in
 * server/services/site-diary-rollup.ts; this seam only authorises and reports.
 *
 * IDEMPOTENT + HUMAN-SAFE: the write is keyed by (org_id, job_id, entry_date)
 * (partial unique index, `source='auto_rollup'`), so a re-run refreshes rather
 * than duplicates, and a day that already carries a MANUAL entry is skipped —
 * the roll-up never overwrites or sits beside a person's own account.
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { status, payload } = await withCronTelemetry("site-diary-rollup", async () => {
    const summary = await runSiteDiaryRollup();
    return { ...summary };
  });
  return NextResponse.json(payload, { status });
}
