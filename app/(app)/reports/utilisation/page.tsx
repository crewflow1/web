import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { buildReportDocument } from "@/lib/reports/report-data";
import { ReportView } from "../_report-view";

/**
 * /reports/utilisation — Staff utilisation. Composes the intelligence
 * utilisation authority (gatherUtilisation → computeUtilisation): rostered vs
 * recorded hours per member over the last 30 London days.
 */
export default async function UtilisationReportPage() {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const doc = await buildReportDocument(supabase, ctx.org.id, "utilisation");
  return <ReportView doc={doc} />;
}
