import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { buildReportDocument } from "@/lib/reports/report-data";
import { ReportView } from "../_report-view";

/**
 * /reports/profit — Profit & loss. Composes the job-profitability authority
 * (lib/profitability/compute) into monthly P&L + per-job margins.
 */
export default async function ProfitReportPage() {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const doc = await buildReportDocument(supabase, ctx.org.id, "profit");
  return <ReportView doc={doc} />;
}
