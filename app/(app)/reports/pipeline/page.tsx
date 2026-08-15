import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { buildReportDocument } from "@/lib/reports/report-data";
import { ReportView } from "../_report-view";

/**
 * /reports/pipeline — Sales pipeline value. Composes the leads bucketing
 * authority (bucketPipelineLeads): open pipeline value + lead count by stage.
 */
export default async function PipelineReportPage() {
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const doc = await buildReportDocument(supabase, ctx.org.id, "pipeline");
  return <ReportView doc={doc} />;
}
