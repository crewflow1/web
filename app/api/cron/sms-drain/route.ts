import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { drainSmsQueue, cleanupOldSmsDeliveries } from "@/lib/notifications/sms";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * MP Wave W4 — SMS notification drain.
 *
 *   GET /api/cron/sms-drain
 *
 * Vercel cron hits this every minute (schedule in vercel.json). Picks up to 50
 * queued sms_deliveries whose scheduled_for is in the past and dispatches each as
 * an SMS via the Twilio transport (lib/comms getSmsProvider) to the recipient's
 * CURRENT phone (public.users.phone). Transient failures reschedule via
 * exponential backoff in lib/notifications/sms.ts.
 *
 * DARK-safe: with no Twilio credentials configured, the drain marks the batch
 * 'skipped' (refuse-before-send) rather than attempting a send that can only fail.
 *
 * Once a day this also prunes settled rows older than 30 days.
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const skipCleanup = url.searchParams.get("skip_cleanup") === "1";

  const { status, payload } = await withCronTelemetry("sms-drain", async () => {
    const summary = await drainSmsQueue();
    const pruned = skipCleanup ? 0 : await cleanupOldSmsDeliveries();
    return { ok: true, summary, pruned };
  });
  return NextResponse.json(payload, { status });
}
