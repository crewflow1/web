import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { runAlertsScheduler } from "@/server/services/hq-alerts-scheduler";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * Phase 3 — Alerts scheduler.
 *
 *   GET /api/cron/alerts-poll
 *
 * Vercel cron hits this nightly (schedule in vercel.json). Builds
 * the live alerts snapshot, runs the deterministic rule engine,
 * and emits HQ notifications for newly-fired CRITICAL alerts.
 *
 * Dedup story:
 *   admin_alert_state.notified_at is stamped the first time HQ is
 *   notified about (rule_id, org_id). Subsequent runs see the
 *   stamp and SKIP. Resolved / snoozed rows are also skipped.
 *   So HQ gets ONE email per (rule, org) until the operator
 *   resolves the alert or it ages out by being resolved.
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { status, payload } = await withCronTelemetry("alerts-poll", async () => {
    const summary = await runAlertsScheduler();
    return { ok: true, summary };
  });
  return NextResponse.json(payload, { status });
}
