import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { runReviewRequestSends } from "@/server/services/review-requests";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * GET /api/cron/review-requests — Phase H hourly (cheap, low-traffic).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { status, payload } = await withCronTelemetry(
    "review-requests",
    async () => {
      const summary = await runReviewRequestSends();
      return { ok: true, summary };
    },
  );
  return NextResponse.json(payload, { status });
}
