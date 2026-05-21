import { NextResponse } from "next/server";
import { requireOrgContext } from "@/server/auth/session";
import {
  jobsPerWeek,
  revenuePerMonth,
  vatPerQuarter,
  topCustomersByRevenue,
} from "@/lib/reports/aggregates";

/**
 * GET /api/reports
 *
 * Returns all four report aggregates in one round-trip. RLS-scoped via
 * the user JWT; only members of the caller's active org see anything.
 *
 *   - jobs_per_week         last 8 weeks
 *   - revenue_per_month     last 12 months (paid invoices)
 *   - vat_per_quarter       last 4 quarters (output / input / net)
 *   - top_customers         all-time, top 10 by paid-invoice revenue
 */
export async function GET() {
  try {
    await requireOrgContext();
    const [jobs_per_week, revenue_per_month, vat_per_quarter, top_customers] =
      await Promise.all([
        jobsPerWeek(8),
        revenuePerMonth(12),
        vatPerQuarter(4),
        topCustomersByRevenue(10),
      ]);
    return NextResponse.json({
      ok: true,
      jobs_per_week,
      revenue_per_month,
      vat_per_quarter,
      top_customers,
    });
  } catch (e) {
    console.error("[reports] unhandled", e);
    return NextResponse.json(
      { ok: false, error: "Reports temporarily unavailable" },
      { status: 500 },
    );
  }
}
