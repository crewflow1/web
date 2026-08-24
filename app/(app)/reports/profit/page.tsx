import { redirect } from "next/navigation";
import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { buildReportDocument } from "@/lib/reports/report-data";
import { ReportView } from "../_report-view";

/**
 * /reports/profit — Profit & loss. Composes the job-profitability authority
 * (lib/profitability/compute) into monthly P&L + per-job margins.
 *
 * Management-only (registry `profit.managementOnly`): the P&L is labour-cost-
 * derived, and since staff_compensation (20261218) put pay behind self-or-admin
 * RLS a non-admin would read only their own rate → an overstated, WRONG profit.
 * Gate the page like the export route already gates the download (403), so the
 * nav-level admin-only Reports area is enforced on the direct URL too.
 */
export default async function ProfitReportPage() {
  const { ctx } = await requireOrgContext();
  const role = ctx.membership.role;
  if (role !== "owner" && role !== "admin") redirect("/reports");
  const supabase = await createClient();
  const doc = await buildReportDocument(supabase, ctx.org.id, "profit");
  return <ReportView doc={doc} />;
}
