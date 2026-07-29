import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { getPermit } from "@/app/(app)/health-safety/permits/_data";
import { listAcknowledgements } from "@/app/(app)/health-safety/_signoff-data";
import { PermitPdf, type PermitPdfInput } from "@/lib/pdf/permit-pdf";
import { effectiveStatus, type PermitStatus } from "@/lib/health-safety/permits";

/**
 * Permit-to-Work evidence PDF (H&S M4). RLS-scoped. Only a permit that has been
 * issued (reference allocated) renders — a draft has no evidence record. H&S
 * content only.
 */
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  // Auth gate AND scope: RLS admits every org the viewer belongs to, so the
  // subject is pinned to the ACTIVE org here. The header below still labels the
  // PDF with the SUBJECT's own org — which, given the pin, is the active one.
  const { ctx } = await requireOrgContext();
  const { id } = await params;

  const result = await getPermit(ctx.org.id, id);
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { permit, conditions } = result;
  if (permit.status === "draft") return NextResponse.json({ error: "Not issued" }, { status: 409 });

  const supabase = await createClient();
  const t = (name: string) => (supabase as unknown as { from: (t: string) => any }).from(name); // eslint-disable-line @typescript-eslint/no-explicit-any
  // Label the evidence with the SUBJECT's own org (RLS already proved the caller
  // is a member of it), not the caller's currently-active org — a member of
  // several orgs must never see one org's permit under another's letterhead.
  const orgRow = await t("organizations").select("name").eq("id", permit.org_id).maybeSingle();
  const ramsRef = permit.risk_assessment_id
    ? (await t("risk_assessments").select("reference").eq("id", permit.risk_assessment_id).maybeSingle()).data?.reference ?? null
    : null;
  const signoffs = await listAcknowledgements("permit_to_work", permit.id);

  const input: PermitPdfInput = {
    org_name: orgRow.data?.name ?? "CrewFlow",
    reference: permit.reference ?? "PTW",
    permit_type: permit.permit_type,
    title: permit.title,
    scope: permit.scope,
    location: permit.location,
    responsible_person: permit.responsible_person,
    isolation_details: permit.isolation_details,
    emergency_arrangements: permit.emergency_arrangements,
    rams_reference: ramsRef,
    valid_from: permit.valid_from,
    valid_until: permit.valid_until,
    status: permit.status,
    effective_status: effectiveStatus(permit.status as PermitStatus, permit.valid_until, new Date()),
    issued_at: permit.issued_at,
    closeout_notes: permit.closeout_notes,
    closed_at: permit.closed_at,
    conditions: conditions.map((cnd) => ({ label: cnd.label, required: cnd.required, confirmed: cnd.confirmed, confirmed_at: cnd.confirmed_at })),
    signoffs: signoffs.map((so) => ({ signer_name: so.signer_name, signed_name: so.signed_name, acknowledged_at: so.acknowledged_at })),
    generated_at: new Date().toISOString(),
  };

  const buffer = await renderToBuffer(PermitPdf({ p: input }));
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${input.reference}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
