import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { isWeatherAvailable } from "@/lib/weather/readiness";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import { runWeatherDelayDetection } from "@/server/services/weather-delay-detect";

/**
 * Weather intelligence — automatic weather → delay-event detection cron seam.
 *
 *   GET /api/cron/weather-delay-detect
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SCHEDULED, BUT STILL DARK — the weather-fetch posture, verbatim.
 * ═══════════════════════════════════════════════════════════════════════════
 * This route IS registered in vercel.json (once daily, in the small hours after
 * the site-diary roll-up and after the overnight observation fetch, so the day's
 * observations are in the cache). Scheduling is decoupled from activation: with
 * no provider bound — every environment today — each tick short-circuits to a
 * 204 no-op below, reading NOTHING and writing NOTHING. Wiring it in advance
 * means activation day is a pure config flip (provider selection + credential),
 * not "write and review a producer under time pressure".
 *
 * DARK ⇒ 204 NO-OP WITH ZERO DATABASE ACCESS. The readiness gate sits BEFORE
 * `withCronTelemetry` on purpose: telemetry writes a `cron_runs` row through the
 * admin client, and a dark tick that wrote telemetry would be a scheduled job
 * burning a row every night to record that nothing can happen. The gate is
 * repeated inside the service (before any client) so the darkness is enforced in
 * two independent places.
 *
 * When live, one tick = one `runWeatherDelayDetection` pass over yesterday: read
 * each live job's district observations from the cache, run the pure decision
 * layer, and raise a DRAFT weather delay for any proven stoppage — idempotent,
 * never touching a manual delay. The service never throws; its summary lands in
 * the telemetry payload.
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth), which also suppresses every cron
 * during a maintenance window. Returns 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One pass reads the cache and writes drafts for every live job's district;
// give it a generous budget. It is internal-only (no vendor call).
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // The dark no-op: BEFORE telemetry, before any client — zero DB access.
  if (!isWeatherAvailable()) {
    return new NextResponse(null, { status: 204 });
  }

  const { status, payload } = await withCronTelemetry("weather-delay-detect", async () => {
    const summary = await runWeatherDelayDetection();
    return {
      ok: summary.ok,
      ran: summary.ran,
      date: summary.date,
      jobsConsidered: summary.jobsConsidered,
      districtsResolved: summary.districtsResolved,
      skippedExisting: summary.skippedExisting,
      detected: summary.detected,
      created: summary.created,
      deduped: summary.deduped,
      note: summary.note,
    };
  });
  return NextResponse.json(payload, { status });
}
