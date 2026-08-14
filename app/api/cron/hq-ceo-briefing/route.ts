import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { composeAndRecordCeoBriefing } from "@/server/services/hq-ceo-briefing";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * CrewFlow HQ — the auto morning CEO briefing (P2 HQ AI Operating System).
 *
 *   GET /api/cron/hq-ceo-briefing
 *
 * Vercel cron hits this each morning (schedule in vercel.json) with
 * `Authorization: Bearer <CRON_SECRET>`; anything else gets a 401. It composes the
 * DETERMINISTIC CEO briefing from the CEO board's real signals and records ONE row per
 * day in hq_ceo_briefings (idempotent, first-write-wins) — so the operating system
 * produces its own morning executive read rather than only rendering one on demand.
 *
 * Deterministic + generative-dark: the narrative is composed by pure code
 * (lib/hq/ceo-briefing.ts); the generative prose variant is dark (the store's `source`
 * CHECK admits only 'deterministic'). No model call is made.
 *
 * Idempotent: a duplicate tick for the same day writes nothing and returns the day's
 * existing briefing. Best-effort: composition never throws, so a briefing failure is
 * reported in the summary rather than failing the tick loudly.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { status, payload } = await withCronTelemetry("hq-ceo-briefing", async () => {
    const summary = await composeAndRecordCeoBriefing({ now: new Date() });
    return { ok: summary.ok, summary };
  });
  return NextResponse.json(payload, { status });
}
