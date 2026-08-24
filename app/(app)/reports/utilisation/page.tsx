import { redirect } from "next/navigation";
import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { buildReportDocument } from "@/lib/reports/report-data";
import { ReportView } from "../_report-view";

/**
 * /reports/utilisation — Staff utilisation. Composes the intelligence
 * utilisation authority (gatherUtilisation → computeUtilisation): rostered vs
 * recorded hours per member over the last 30 London days.
 *
 * Management-only (registry `utilisation.managementOnly`): the report carries a
 * per-member hourly-rate column + labour cost, so the same pay-RLS consequence
 * as the profit report applies — gate the direct URL to owner/admin.
 */
export default async function UtilisationReportPage() {
  const { ctx } = await requireOrgContext();
  const role = ctx.membership.role;
  if (role !== "owner" && role !== "admin") redirect("/reports");
  const supabase = await createClient();
  const doc = await buildReportDocument(supabase, ctx.org.id, "utilisation");
  return <ReportView doc={doc} />;
}
