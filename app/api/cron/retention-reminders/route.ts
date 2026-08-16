import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import { runRetentionReminders } from "@/server/services/retention-reminders";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A whole-fleet scan + a bounded claim/notify per due moiety. Give it headroom
// like the other daily money crons; well within the claim lease.
export const maxDuration = 300;

/**
 * Daily cron — retention release reminders.
 *
 * Emits a notification when a job's held-retention moiety reaches its scheduled
 * release date (Practical Completion for the first, end of the Defects Liability
 * Period for the second). Idempotency is a per-moiety CAS marker on `jobs`
 * (retention_first_reminded_at / retention_second_reminded_at), so repeated and
 * concurrent runs fire each moiety exactly once. See
 * server/services/retention-reminders.ts.
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise.
 */
export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ ok: false, error: "unauthorised" }, { status: 401 });
  }

  const result = await withCronTelemetry("retention-reminders", async () => {
    const summary = await runRetentionReminders();
    return { ok: true, ...summary };
  });

  return NextResponse.json(result.payload, { status: result.status });
}
