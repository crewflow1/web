import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { listAcknowledgements } from "@/app/(app)/health-safety/_signoff-data";
import { ToolboxTalkPdf, type ToolboxTalkPdfInput } from "@/lib/pdf/toolbox-talk-pdf";
import type { ToolboxTalkSnapshot } from "@/lib/toolbox-talks/snapshot";

/**
 * Toolbox Talk evidence PDF (M4). RLS-scoped (the talk read + org header + acks all
 * run on the tenant client). Only a DELIVERED (issued/superseded/withdrawn) talk with
 * a frozen snapshot renders — a draft has no evidence record → 409. The document body
 * is the FROZEN snapshot (historical evidence never changes); only the acknowledgement
 * roster is pulled live, exactly as the RAMS/permit PDFs render sign-offs live.
 */
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  // Auth gate AND scope: RLS admits EVERY org the viewer belongs to, so the
  // subject must be pinned to the ACTIVE org here. Without the in-statement
  // .eq("org_id", ctx.org.id) below, a multi-org member active in org A could
  // GET org B's talk PDF (its RLS row is visible to them). Mirrors the sibling
  // permits/[id]/pdf route, which pins via getPermit(ctx.org.id, id).
  const { ctx } = await requireOrgContext();
  const { id } = await params;
  const supabase = await createClient();
  const t = (name: string) => (supabase as unknown as { from: (t: string) => any }).from(name); // eslint-disable-line @typescript-eslint/no-explicit-any

  const { data: talk, error: talkError } = await t("toolbox_talks")
    .select("id, org_id, status, snapshot")
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (talkError) {
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }
  if (!talk) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // A draft (or any talk with no frozen snapshot) is not evidence.
  if (talk.status === "draft" || !talk.snapshot) {
    return NextResponse.json({ error: "Not issued" }, { status: 409 });
  }
  const snap = talk.snapshot as ToolboxTalkSnapshot;

  // Label the evidence with the SUBJECT's own org (RLS already proved membership),
  // never the caller's currently-active org — a multi-org member must not see one
  // org's talk under another's letterhead.
  const orgRow = await t("organizations").select("name").eq("id", talk.org_id).maybeSingle();
  const signoffs = await listAcknowledgements("toolbox_talk", talk.id, ctx.org.id);

  const input: ToolboxTalkPdfInput = {
    org_name: orgRow.data?.name ?? "CrewFlow",
    reference: snap.talk_reference,
    revision: snap.revision,
    // Live status (never draft here — guarded above) so a superseded/withdrawn talk is
    // rendered honestly, not as "Delivered". The body stays the frozen snapshot.
    status: talk.status as "issued" | "superseded" | "withdrawn",
    talk_date: snap.talk_date,
    location: snap.location,
    site_label: snap.site_label,
    delivered_by: snap.delivered_by,
    topic: snap.topic,
    key_points: snap.key_points,
    ppe: snap.ppe ?? [],
    rams_reference: snap.rams_reference,
    rams_revision: snap.rams_revision,
    permit_reference: snap.permit_reference,
    permit_status_at_issue: snap.permit_status_at_issue,
    external_attendees: snap.external_attendees ?? [],
    attendance_note: snap.attendance_note ?? null,
    attendee_count: snap.attendee_count ?? null,
    issued_by_name: snap.issued_by_name,
    issued_on: snap.issued_on,
    signoffs: signoffs.map((so) => ({ signer_name: so.signer_name, signed_name: so.signed_name, acknowledged_at: so.acknowledged_at })),
    generated_at: new Date().toISOString(),
  };

  const buffer = await renderToBuffer(ToolboxTalkPdf({ t: input }));
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${input.reference}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
