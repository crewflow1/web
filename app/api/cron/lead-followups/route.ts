import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { runLeadFollowups } from "@/server/services/lead-followups";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * GET /api/cron/lead-followups — Phase B daily.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { status, payload } = await withCronTelemetry(
    "lead-followups",
    async () => {
      const summary = await runLeadFollowups();
      return { ok: true, summary };
    },
  );
  return NextResponse.json(payload, { status });
}
