import { isRedirectError } from "next/dist/client/components/redirect-error";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import * as respond from "@/lib/api/respond";
import { requireCapabilityApi } from "@/server/auth/capabilities";
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
    const guard = await requireCapabilityApi("reports", "view");
    if (guard instanceof Response) return guard;
    const { ctx } = guard;
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
    // The org guard signals "signed out" / "no usable workspace" by throwing
    // Next's redirect control-flow error. Inside this catch-all it used to
    // surface as a 500 for every such caller; an API answers with the status.
    if (isRedirectError(e)) {
      const to = getURLFromRedirectError(e);
      return to.startsWith("/login")
        ? respond.error(401, "unauthenticated")
        : respond.error(403, "forbidden");
    }
    console.error("[reports] unhandled", e);
    return respond.error(500, "Reports temporarily unavailable");
  }
}
