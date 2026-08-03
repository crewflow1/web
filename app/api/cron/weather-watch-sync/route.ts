import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import { runWeatherWatchSync } from "@/server/services/weather-watch-sync";

/**
 * Weather intelligence — the watch producer's cron seam.
 *
 *   GET /api/cron/weather-watch-sync
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DELIBERATELY NOT GATED ON PROVIDER READINESS — unlike the fetch cron.
 * ═══════════════════════════════════════════════════════════════════════════
 * The sibling weather-fetch route returns a dark 204 before any DB access,
 * because fetching costs a provider call and there is no provider. This route
 * does the OPPOSITE on purpose: producing watches is derived entirely from
 * internal job/site data, calls no vendor, spends nothing, and must run WHETHER
 * OR NOT a provider is bound — so that watches already exist the moment one is,
 * and so the readiness surface can report `hasActiveWatches` honestly. The
 * FETCH half stays dark; the producer does not. (See the service header.)
 *
 * This route IS registered in vercel.json (a few times daily) — that is the
 * point of the fix, and the line that distinguishes it from the fetch cron,
 * which stays absent until the commercial activation decision.
 *
 * The service never throws; its summary lands in the telemetry payload.
 * Auth: Bearer CRON_SECRET (lib/cron/auth), which also suppresses every cron
 * during a maintenance window. Returns 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { status, payload } = await withCronTelemetry("weather-watch-sync", async () => {
    const summary = await runWeatherWatchSync();
    return {
      ok: summary.ok,
      ran: summary.ran,
      jobsConsidered: summary.jobsConsidered,
      districtsResolved: summary.districtsResolved,
      inserted: summary.inserted,
      activated: summary.activated,
      deactivated: summary.deactivated,
      note: summary.note,
    };
  });
  return NextResponse.json(payload, { status });
}
