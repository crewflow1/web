import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import { drainAllDueReminders } from "@/server/services/maintenance-reminders";

/**
 * Maintenance-reminder drain (Phase 7 — proactive send).
 *
 *   GET /api/cron/maintenance-reminders-drain
 *
 * Sweeps every org for warranty servicing/expiry reminders that have entered
 * their lead-time window, records each once (idempotent via the log's dedupe
 * key), and resolves it.
 *
 * DARK-SAFE. This route is live in prod the day it ships, but sends NOTHING
 * while the feature is dark: with `NEXT_PUBLIC_FEATURE_MAINTENANCE_REMINDERS`
 * off (the default), every due reminder is recorded `skipped_dark` and no email
 * leaves the building. Turning it on is the env flip plus a sendable email
 * provider — no code change and no redeploy of this route. Running the cron now
 * means the log is populated and observable before the switch is ever flipped.
 *
 * Daily at 06:00, after the 05:30 asset maintenance-due generator: warranty
 * reminders are day-scale, so a daily sweep is ample and minute-scale would be
 * pure noise.
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
  const { status, payload } = await withCronTelemetry("maintenance-reminders-drain", async () => {
    const summary = await drainAllDueReminders();
    return { ...summary };
  });
  return NextResponse.json(payload, { status });
}
