import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import {
  drainPushQueue,
  cleanupOldPushDeliveries,
} from "@/lib/notifications/push";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * MP Wave R4 — Web Push drain.
 *
 *   GET /api/cron/push-drain
 *
 * Vercel cron hits this every minute (schedule in vercel.json). Picks up to 50
 * queued push_deliveries whose scheduled_for is in the past and dispatches each
 * as an encrypted Web Push (RFC 8291) to the recipient's current subscriptions,
 * pruning any that the push service reports gone (404/410). Transient failures
 * reschedule via exponential backoff in lib/notifications/push.ts.
 *
 * DARK-safe: with no VAPID keys configured, the drain marks the batch 'skipped'
 * (refuse-before-send) rather than attempting a send that can only fail.
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

  const { status, payload } = await withCronTelemetry("push-drain", async () => {
    const summary = await drainPushQueue();
    const pruned = skipCleanup ? 0 : await cleanupOldPushDeliveries();
    return { ok: true, summary, pruned };
  });
  return NextResponse.json(payload, { status });
}
