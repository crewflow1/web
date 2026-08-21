import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import {
  drainPushQueue,
  cleanupOldPushDeliveries,
  isPushConfigured,
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
 * DARK GATE (SWITCH 1) — checked immediately after the Bearer gate, before any
 * admin client is built or any row is read, so a dark deploy costs ZERO database
 * work. This mirrors /api/cron/webhook-dispatch, the reference pattern.
 *
 * Why this is safe rather than merely cheap: `enqueuePushForNotifications`
 * short-circuits on the SAME predicate (`if (!isPushConfigured()) return 0`), so
 * while the channel is dark nothing can enter push_deliveries in the first
 * place. The drain and the enqueue are gated by one switch, so an early return
 * here can never strand a queue — there is nothing to strand. The daily
 * `cleanupOldPushDeliveries` pass is likewise a no-op against a table that
 * cannot have grown.
 *
 * Once a day (when configured) this also prunes settled rows older than 30 days.
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Dark gate — zero DB work, and no telemetry row, before the switch flips.
  // No body on a 204.
  if (!isPushConfigured()) {
    return new NextResponse(null, { status: 204 });
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
