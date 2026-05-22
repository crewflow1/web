import { NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { buildAnalyticsSnapshot, pickHighestRiskCustomers } from "@/server/services/hq-analytics-snapshot";
import {
  computeRevenueAnalytics,
  computeCustomerAnalytics,
  computeBenchmarks,
  buildInsightsPanel,
} from "@/lib/hq/analytics";
import { AnalyticsPdf } from "@/lib/pdf/analytics-pdf";

/**
 * CrewFlow HQ — Analytics PDF export (HQ-6).
 *
 * GET /api/admin/analytics/export.pdf
 *
 * Gated by isSuperAdminEmail. Renders the AnalyticsPdf component
 * server-side via @react-pdf/renderer.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) {
    return NextResponse.json({ error: "not_authorised" }, { status: 404 });
  }

  const snap = await buildAnalyticsSnapshot();
  const revenue = computeRevenueAnalytics(snap);
  const customer = computeCustomerAnalytics(snap);
  const benchmarks = computeBenchmarks(snap);
  const insights = buildInsightsPanel(
    revenue,
    customer,
    benchmarks,
    pickHighestRiskCustomers(snap),
  );

  const buffer = await renderToBuffer(
    AnalyticsPdf({
      data: {
        generatedAt: snap.generatedAt,
        revenue,
        customer,
        benchmarks,
        insights,
      },
    }),
  );
  const ab = new ArrayBuffer(buffer.length);
  new Uint8Array(ab).set(buffer);

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(ab, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="crewflow-hq-analytics-${stamp}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
