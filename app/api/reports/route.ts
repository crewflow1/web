import * as respond from "@/lib/api/respond";
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
    const { ctx } = await requireOrgContext();
    const [jobs_per_week, revenue_per_month, vat_per_quarter, top_customers] =
      await Promise.all([
        jobsPerWeek(ctx.org.id, 8),
        revenuePerMonth(ctx.org.id, 12),
        vatPerQuarter(ctx.org.id, 4),
        topCustomersByRevenue(ctx.org.id, 10),
      ]);
    return respond.json({
      ok: true,
      jobs_per_week,
      revenue_per_month,
      vat_per_quarter,
      top_customers,
    });
  } catch (e) {
    console.error("[reports] unhandled", e);
    return respond.error(500, "Reports temporarily unavailable");
  }
}
