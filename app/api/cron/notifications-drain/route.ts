import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import {
  drainNotificationEmailQueue,
  cleanupOldEmailRows,
} from "@/lib/notifications/email";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * Phase 2 — Notification email drain.
 *
 *   GET /api/cron/notifications-drain
 *
 * Vercel cron hits this every 15 minutes (schedule in vercel.json).
 * Picks up to 50 queued rows whose scheduled_for is in the past
 * and dispatches them via Resend. Failures schedule themselves
 * back via exponential backoff in lib/notifications/email.ts.
 *
 * Once a day this also runs the cleanup that prunes sent / skipped
 * rows older than 90 days.
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

  const { status, payload } = await withCronTelemetry(
    "notifications-drain",
    async () => {
      const summary = await drainNotificationEmailQueue();
      const pruned = skipCleanup ? 0 : await cleanupOldEmailRows();
      return { ok: true, summary, pruned };
    },
  );
  return NextResponse.json(payload, { status });
}
