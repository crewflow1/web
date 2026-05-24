import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { recomputeAllOrgs } from "@/server/services/hq-health-recompute";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * CrewFlow HQ — Nightly health-score recompute (HQ-6).
 *
 * Vercel cron hits this endpoint with `Authorization: Bearer
 * <CRON_SECRET>` on the schedule in vercel.json. Anything else
 * gets a 401.
 *
 * Strategy:
 *   1. Authorise the request (bail with 401 if not).
 *   2. Run the recompute engine against every org with
 *      trigger='cron'.
 *   3. Return a JSON summary the platform can log.
 *
 * Idempotent — orgs whose computed score hasn't changed write
 * nothing.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { status, payload } = await withCronTelemetry(
    "health-recompute",
    async () => {
      const summary = await recomputeAllOrgs("cron", null);
      return { ok: true, summary };
    },
  );
  return NextResponse.json(payload, { status });
}
