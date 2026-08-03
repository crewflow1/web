import { NextResponse } from "next/server";

import { isCronAuthorised } from "@/lib/cron/auth";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";
import {
  telematicsProviderReady,
} from "@/lib/integrations/telematics/adapters";
import { resolveActiveTelematicsProvider } from "@/lib/integrations/telematics/oauth";
import { runTelematicsSync } from "@/server/services/telematics-sync";

/**
 * Telematics reading SYNC — the cron seam (20261103).
 *
 *   GET /api/cron/telematics-sync
 *
 * This is the caller the C26 audit found MISSING: `syncTelematicsReadings` had no
 * cron / route / button, so a live feed would never have written a reading. This
 * route is that trigger.
 *
 * ── SCHEDULED, BUT DARK-SAFE ────────────────────────────────────────────────
 * Unlike the weather cron (deliberately absent from vercel.json), this route IS
 * scheduled — because the mandate is that activation be "credentials + flag only".
 * If scheduling were deferred, going live would ALSO require a vercel.json deploy;
 * scheduling the dark route now means the already-wired tick starts doing real
 * work the moment the provider is bound + the flag is on, with no further deploy.
 *
 * DARK ⇒ 204 NO-OP WITH ZERO DATABASE ACCESS. The readiness gate sits BEFORE
 * `withCronTelemetry` on purpose: telemetry writes a `cron_runs` row through the
 * admin client, and a dark tick that wrote telemetry would burn a row every few
 * minutes to record that nothing can happen. When someone schedules this before
 * activating the provider, every tick is an empty 204: harmless, cheap, honest —
 * the weather-cron / health-probe posture (report cheaply, touch nothing).
 *
 * When live, one tick = one bounded `runTelematicsSync` pass: connected orgs for
 * the bound provider → decrypt tokens → refresh-if-expired → fetch + map through
 * the pure reading mapper → service-role idempotent write (ON CONFLICT DO NOTHING).
 *
 * Auth: Bearer CRON_SECRET (lib/cron/auth). Returns 401 otherwise.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A pass may call the aggregator once per connected org with a bounded retry;
// give it a generous budget. The pass itself is bounded by the connection count.
export const maxDuration = 60;

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // The dark no-op: BEFORE telemetry, before any client — zero DB access. Mirrors
  // runTelematicsSync's own guard so a scheduled-but-dark tick touches nothing.
  const provider = resolveActiveTelematicsProvider();
  if (!provider || !telematicsProviderReady(provider)) {
    return new NextResponse(null, { status: 204 });
  }

  const { status, payload } = await withCronTelemetry("telematics-sync", async () => {
    const summary = await runTelematicsSync();
    // Compact: per-outcome counts, not the connection-by-connection list.
    const counts: Record<string, number> = {};
    for (const o of summary.outcomes) {
      counts[o.outcome] = (counts[o.outcome] ?? 0) + 1;
    }
    return {
      ok: true,
      ran: summary.ran,
      provider: summary.provider,
      connections: summary.connections,
      written: summary.written,
      outcomes: counts,
      note: summary.note,
    };
  });
  return NextResponse.json(payload, { status });
}
