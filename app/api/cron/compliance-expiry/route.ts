import { NextResponse } from "next/server";
import { isCronAuthorised } from "@/lib/cron/auth";
import { runComplianceExpiry } from "@/server/services/compliance-docs";
import { withCronTelemetry } from "@/lib/ops/cron-telemetry";

/**
 * GET /api/cron/compliance-expiry — Phase E daily.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  if (!isCronAuthorised(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { status, payload } = await withCronTelemetry(
    "compliance-expiry",
    async () => {
      const summary = await runComplianceExpiry();
      return { ok: true, summary };
    },
  );
  return NextResponse.json(payload, { status });
}
