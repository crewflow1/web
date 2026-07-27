import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { drainRegisteredConsumers, getSpineGoldenSignals } from "@/server/services/spine-consumer";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * CrewFlow HQ — Event Spine offset drainer (Module 1, PR3).
 *
 *   GET /api/cron/spine-drain
 *
 * The guaranteed-delivery path for the spine (CEO decision D2 — cron only, no
 * LISTEN/NOTIFY). Each run drains every registered consumer once: read a bounded
 * batch in id-order, apply each event idempotently, advance the offset in the same
 * transaction, dead-letter a poison event after N attempts. Idempotent and safe to
 * run as often as the schedule fires — a run with nothing new is a no-op.
 *
 * Ships DARK: short-circuits when `event_spine.consumer_enabled` is off, and in
 * prod no consumer is registered yet, so this is a no-op until PR5 registers the
 * timeline projection. The run's `cron_runs` row IS the drainer-health golden
 * signal (Ch.15).
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

  const { status, payload } = await withCronTelemetry("spine-drain", async () => {
    const drain = await drainRegisteredConsumers();
    // Golden signals are a cheap read; surface them so the cron run records lag +
    // dead-event count alongside what it drained (the lag canary, Ch.15).
    const signals = drain.enabled ? await getSpineGoldenSignals() : null;
    return { ok: drain.ok, drain, signals };
  });
  return NextResponse.json(payload, { status });
}
