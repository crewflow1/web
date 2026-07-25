import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { getRiskAssessment, listAssessors } from "@/app/(app)/health-safety/_data";
import { listAcknowledgements } from "@/app/(app)/health-safety/_signoff-data";
import { RamsPdf, type RamsPdfInput } from "@/lib/pdf/rams-pdf";

/**
 * RAMS evidence PDF (H&S M4). RLS-scoped via the user JWT (requireOrgContext). Only
 * an ISSUED RAMS renders — a draft has no numbered, frozen record to produce. The
 * PDF carries H&S content only (no cost/margin fields exist on the source).
 */
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  await requireOrgContext(); // auth gate; the header + data are scoped by RLS + the subject's own org
  const { id } = await params;

  const result = await getRiskAssessment(id);
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { ra, hazards } = result;
  if (ra.status === "draft") return NextResponse.json({ error: "Not issued" }, { status: 409 });

  const supabase = await createClient();
  // Label the evidence with the SUBJECT's own org (RLS already proved the caller is
  // a member of it), not the caller's currently-active org.
  const orgRow = await (supabase as unknown as { from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: { name: string } | null }> } } } })
    .from("organizations").select("name").eq("id", ra.org_id).maybeSingle();

  const assessors = await listAssessors();
  const signoffs = await listAcknowledgements("risk_assessment", ra.id);

  const input: RamsPdfInput = {
    org_name: orgRow.data?.name ?? "CrewFlow",
    reference: ra.reference ?? "RAMS",
    title: ra.title,
    activity: ra.activity,
    location: ra.location,
    assessor_name: ra.assessor_id ? (assessors.find((a) => a.id === ra.assessor_id)?.name ?? null) : null,
    assessment_date: ra.assessment_date,
    review_date: ra.review_date,
    ppe: ra.ppe ?? [],
    method_statement: ra.method_statement,
    status: ra.status,
    revision_number: ra.revision_number,
    issued_at: ra.issued_at,
    hazards: hazards.map((h) => ({
      hazard: h.hazard, who_at_risk: h.who_at_risk,
      likelihood: h.likelihood, severity: h.severity, control_measures: h.control_measures,
      residual_likelihood: h.residual_likelihood, residual_severity: h.residual_severity,
    })),
    signoffs: signoffs.map((so) => ({ signer_name: so.signer_name, signed_name: so.signed_name, acknowledged_at: so.acknowledged_at })),
    generated_at: new Date().toISOString(),
  };

  const buffer = await renderToBuffer(RamsPdf({ ra: input }));
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${input.reference}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
