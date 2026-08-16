import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { drainReadySagaSteps } from "@/server/services/hq-workflow";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * CrewFlow HQ — autonomous saga-drain (Decision-Centre + Saga automation milestone).
 *
 *   GET /api/cron/saga-drain
 *
 * Vercel cron hits this every 5 minutes (schedule in vercel.json). It advances saga
 * steps whose dependencies are `done`, replacing the manual-ONLY advance the saga
 * board shipped with — EXCEPT steps that map to an approval-gated action, which are
 * left for a super-admin's manual advance (the human approval). The manual control
 * stays; this is the autonomous complement.
 *
 * SAFE + IDEMPOTENT. Dispatch is guarded by each step's STABLE dedupe key
 * (`saga_step:<id>`), so two overlapping ticks can never create two tasks for a step;
 * an already-dispatched step is only re-synced from its real task status (progress
 * propagation, not a new action). BOUNDED per pass, ordered stalest-first, so no tail
 * can starve. It NEVER decides, approves, or takes an irreversible external action —
 * it only opens internal Task-Engine work through the sanctioned entry point.
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
  const url = new URL(request.url);
  const limitRaw = Number(url.searchParams.get("limit"));
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;

  const { status, payload } = await withCronTelemetry("saga-drain", async () => {
    const summary = await drainReadySagaSteps({ limit });
    return { ok: true, summary };
  });
  return NextResponse.json(payload, { status });
}
