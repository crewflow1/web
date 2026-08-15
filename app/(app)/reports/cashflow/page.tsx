import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { buildReportDocument } from "@/lib/reports/report-data";
import { ReportView } from "../_report-view";

/**
 * /reports/cashflow — Cashflow forecast. Composes the forecasting cash-timeline
 * authority (gatherCashTimeline → computeCashTimeline): a week-by-week projection
 * of cash MOVEMENT (not a bank balance) over the next quarter.
 *
 * MANAGEMENT-ONLY. The timeline's outflow side (VAT / CIS / supplier payables)
 * is admin-only at RLS, so a non-admin would see an understated forecast. This
 * page refuses to draw it for a non-admin rather than show half a ledger — the
 * same gate `server/services/forecasting.loadForecasts` applies.
 */
export default async function CashflowReportPage() {
  const { ctx } = await requireOrgContext();
  const isAdmin =
    ctx.membership.role === "owner" || ctx.membership.role === "admin";

  if (!isAdmin) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold text-slate-900">Cashflow forecast</h1>
        <div
          role="status"
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
        >
          The cashflow forecast includes VAT, CIS and supplier payments, which
          are visible to owners and admins only. Ask an admin to share it with
          you.
        </div>
      </div>
    );
  }

  const supabase = await createClient();
  const doc = await buildReportDocument(supabase, ctx.org.id, "cashflow");
  return <ReportView doc={doc} />;
}
