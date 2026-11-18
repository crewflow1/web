import { requireOrgContext } from "@/server/auth/session";
import { createClient } from "@/lib/supabase/server";
import { buildReportDocument } from "@/lib/reports/report-data";
import { ReportView } from "../_report-view";
import { requireCapability } from "@/server/auth/capabilities";

/**
 * /reports/pipeline — Sales pipeline value. Composes the leads bucketing
 * authority (bucketPipelineLeads): open pipeline value + lead count by stage.
 */
export default async function PipelineReportPage() {
  // Page-level copy of the segment gate: a layout's gate does not stop this
  // page from rendering in parallel, so the page enforces it before any data.
  await requireCapability("reports", "view");
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();
  const doc = await buildReportDocument(supabase, ctx.org.id, "pipeline");
  return <ReportView doc={doc} />;
}
