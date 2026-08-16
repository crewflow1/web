import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { runDecisionAutoProposal } from "@/server/services/hq-decision-autoproposal";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * CrewFlow HQ — Decision-Centre auto-proposal (Decision-Centre + Saga automation).
 *
 *   GET /api/cron/hq-decision-autopropose
 *
 * Vercel cron hits this daily, just after the alerts poll (schedule in vercel.json).
 * It reads the platform's REAL signals (the HQ alert-rules engine's live snapshot),
 * maps the CRITICAL ones to DRAFT decision proposals, and OPENS each one in the
 * Decision Centre as a `proposed` row for a HUMAN to approve/reject/delay/delegate.
 *
 * It NEVER decides and NEVER executes — opening a proposal is the whole action. Each
 * proposal carries the signal's stable key, and a partial-unique index makes a repeat
 * for the same signal a clean no-op, so this can run daily (and overlap itself)
 * without ever raising a duplicate.
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
  const { status, payload } = await withCronTelemetry(
    "hq-decision-autopropose",
    async () => {
      const summary = await runDecisionAutoProposal();
      return { ok: true, summary };
    },
  );
  return NextResponse.json(payload, { status });
}
