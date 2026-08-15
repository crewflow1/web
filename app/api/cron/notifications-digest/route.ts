import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { runNotificationDigest } from "@/server/services/notification-preferences-service";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * P3 Notifications — per-user email digest.
 *
 *   GET /api/cron/notifications-digest
 *
 * Vercel cron hits this once a day (schedule in vercel.json). For every user who
 * opted a notification category into a daily / weekly cadence, it batches every
 * digest-eligible notification created since that user's per-cadence cursor into
 * ONE email and enqueues it on the shared notification_email_queue — the SAME
 * queue drained → Resend by /api/cron/notifications-drain. So THIS cron performs
 * no network I/O of its own (only DB reads + queue inserts) and is self-draining
 * (advancing each cursor removes those notifications from the next pass). Weekly
 * digests fire only on the configured weekday; daily digests every run.
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { status, payload } = await withCronTelemetry(
    "notifications-digest",
    async () => {
      const summary = await runNotificationDigest();
      return { ok: true, summary };
    },
  );
  return NextResponse.json(payload, { status });
}
