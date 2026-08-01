import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { isWeatherAvailable } from "@/lib/weather/readiness";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import { runWeatherFetch } from "@/server/services/weather-fetch";

/**
 * Weather intelligence — the fetch pipeline's cron seam.
 *
 *   GET /api/cron/weather-fetch
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * DELIBERATELY NOT SCHEDULED. This route is ABSENT from vercel.json, and that
 * absence is part of the design: scheduling it is an ACTIVATION step (after
 * the commercial provider decision and the credential), not an engineering
 * one. The route existing unscheduled means activation day is "add one crons
 * entry" rather than "write and review a pipeline under time pressure" — the
 * same posture as the unscheduled purge function in migration 20261074. The
 * security suite pins vercel.json's silence about this path.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DARK ⇒ 204 NO-OP WITH ZERO DATABASE ACCESS. The readiness gate sits BEFORE
 * `withCronTelemetry` on purpose: telemetry writes a `cron_runs` row through
 * the admin client, and a dark tick that wrote telemetry would be a scheduled
 * job burning a row every few hours to record that nothing can happen — the
 * health probe posture (report cheaply, touch nothing) applies here too. When
 * someone schedules this route before activating the provider, every tick is
 * an empty 204: harmless, cheap, honest.
 *
 * When live, one tick = one bounded `runWeatherFetch` pass: distinct watched
 * districts → freshness skip → resolve → fetch (retry/backoff + breaker) →
 * service-role upsert. The service never throws; its summary lands in the
 * telemetry payload with per-outcome counts.
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// One pass may call the vendor for many districts with bounded backoff between
// retries; give it the full budget. MAX_DISTRICTS_PER_RUN bounds it beneath.
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // The dark no-op: BEFORE telemetry, before any client — zero DB access.
  if (!isWeatherAvailable()) {
    return new NextResponse(null, { status: 204 });
  }

  const { status, payload } = await withCronTelemetry("weather-fetch", async () => {
    const summary = await runWeatherFetch();
    // Compact: counts per outcome kind, not the district-by-district list —
    // a national watch list would otherwise write a very large telemetry row.
    const counts: Record<string, number> = {};
    for (const o of summary.outcomes) {
      counts[o.outcome] = (counts[o.outcome] ?? 0) + 1;
    }
    return {
      ok: summary.ok,
      ran: summary.ran,
      provider: summary.provider,
      districts: summary.districtCount,
      written: summary.written,
      breakerTripped: summary.breakerTripped,
      outcomes: counts,
      note: summary.note,
    };
  });
  return NextResponse.json(payload, { status });
}
