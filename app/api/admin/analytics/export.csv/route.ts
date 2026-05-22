import { NextResponse } from "next/server";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { buildAnalyticsSnapshot } from "@/server/services/hq-analytics-snapshot";
import {
  computeRevenueAnalytics,
  computeCustomerAnalytics,
  computeBenchmarks,
  analyticsToCsv,
} from "@/lib/hq/analytics";

/**
 * CrewFlow HQ — Analytics CSV export (HQ-6).
 *
 * GET /api/admin/analytics/export.csv
 *
 * Gated by isSuperAdminEmail. Serialises the same numbers the
 * /admin/analytics page shows so a finance team can paste into
 * a spreadsheet.
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
  const csv = analyticsToCsv(revenue, customer, benchmarks);

  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="crewflow-hq-analytics-${stamp}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
