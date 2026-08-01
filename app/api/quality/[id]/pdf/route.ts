import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { getPlan, listPlanNcrs, loadUserNames } from "@/app/(app)/quality/_data";
import { isLive } from "@/lib/quality/ncr";
import { ItpPdf, type ItpPdfInput } from "@/lib/pdf/itp-pdf";

/**
 * ITP evidence PDF (Works Quality M2). RLS-scoped via the user JWT
 * (requireOrgContext) AND pinned to the ACTIVE org — getPlan carries
 * ctx.org.id on every read, so a dual-org member can only render the company
 * they are working in. Only a plan that has LEFT DRAFT renders (409 on a
 * draft: there is no numbered, frozen record to produce); superseded and
 * withdrawn plans render as the historical evidence they are.
 *
 * NOT STORED: regenerated per request from the database (the
 * health-safety/[id]/pdf exemplar). Cache-Control: private, no-store.
 *
 * LETTERHEAD IS THE ACTIVE ORG'S, BY CONSTRUCTION. A cross-org letterhead was
 * a real past defect class: here the org name is read by ctx.org.id — the
 * same pin every underlying read carries — so the header can never name a
 * different company than the data under it.
 */
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { ctx } = await requireOrgContext();
  const { id } = await params;

  const loaded = await getPlan(ctx.org.id, id);
  if (!loaded) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { plan, items, signoffs, jobLabel } = loaded;
  if (plan.status === "draft") {
    return NextResponse.json({ error: "Not issued" }, { status: 409 });
  }

  const supabase = await createClient();
  // ACTIVE-org letterhead, pinned to ctx.org.id (see header note).
  const orgRow = await (
    supabase as unknown as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: { name: string } | null }> };
        };
      };
    }
  )
    .from("organizations")
    .select("name")
    .eq("id", ctx.org.id)
    .maybeSingle();

  const ncrs = await listPlanNcrs(ctx.org.id, items.map((i) => i.id));
  const openNcrs = ncrs.filter((n) => isLive(n.status));

  const userNames = await loadUserNames([
    ...(plan.prepared_by ? [plan.prepared_by] : []),
    ...openNcrs.map((n) => n.responsible_user_id).filter((u): u is string => Boolean(u)),
  ]);

  const liveByItem = new Map(
    signoffs.filter((so) => so.voided_at === null).map((so) => [so.inspection_plan_item_id, so]),
  );
  const itemNumberById = new Map(items.map((i) => [i.id, i.item_number]));

  const input: ItpPdfInput = {
    org_name: orgRow.data?.name ?? "CrewFlow",
    reference: plan.reference ?? "ITP",
    title: plan.title,
    work_package: plan.work_package,
    location: plan.location,
    specification_ref: plan.specification_ref,
    job_label: jobLabel,
    status: plan.status,
    revision_number: plan.revision_number,
    issued_at: plan.issued_at,
    prepared_by_name: plan.prepared_by ? (userNames.get(plan.prepared_by) ?? null) : null,
    items: items.map((i) => {
      const so = liveByItem.get(i.id) ?? null;
      return {
        item_number: i.item_number,
        title: i.title,
        acceptance_criteria: i.acceptance_criteria,
        inspection_method: i.inspection_method,
        specification_ref: i.specification_ref,
        control_point: i.control_point,
        is_hold_point: i.is_hold_point,
        required: i.required,
        signoff: so
          ? {
              result: so.result,
              signed_name: so.signed_name,
              inspected_at: so.inspected_at,
              comments: so.comments,
              witness_name: so.witness_name,
              witness_organisation: so.witness_organisation,
              hold_point_breach: so.hold_point_breach,
              open_hold_item_number: so.open_hold_item_number,
            }
          : null,
      };
    }),
    open_ncrs: openNcrs.map((n) => ({
      reference: n.reference,
      title: n.title,
      severity: n.severity,
      status: n.status,
      item_number: itemNumberById.get(n.inspection_plan_item_id) ?? null,
      responsible:
        [
          n.responsible_user_id ? (userNames.get(n.responsible_user_id) ?? null) : null,
          n.responsible_subcontractor,
        ]
          .filter(Boolean)
          .join(" · ") || null,
      due_date: n.due_date,
    })),
    generated_at: new Date().toISOString(),
  };

  const buffer = await renderToBuffer(ItpPdf({ plan: input }));
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${input.reference}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
