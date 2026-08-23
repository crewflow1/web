import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import {
  drainSmsQueue,
  cleanupOldSmsDeliveries,
  isSmsConfigured,
} from "@/lib/notifications/sms";
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
 * DARK GATE (SWITCH 1) — checked immediately after the Bearer gate, before any
 * admin client is built or any row is read, so a dark deploy costs ZERO database
 * work. This mirrors /api/cron/webhook-dispatch, the reference pattern.
 *
 * Why this is safe rather than merely cheap: `enqueueSmsForNotifications`
 * short-circuits on the SAME predicate (`if (!isSmsConfigured()) return 0`), so
 * while the transport is dark nothing can enter sms_deliveries in the first
 * place. The drain and the enqueue are gated by one switch, so an early return
 * here can never strand a queue — there is nothing to strand. The daily
 * `cleanupOldSmsDeliveries` pass is likewise a no-op against a table that cannot
 * have grown.
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
  if (!isSmsConfigured()) {
    return new NextResponse(null, { status: 204 });
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
