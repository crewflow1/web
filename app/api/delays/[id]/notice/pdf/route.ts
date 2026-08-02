import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { requireOrgContext } from "@/server/auth/session";
import { loadEotNotice } from "@/server/services/eot-notice";
import { EotNoticePdf, type EotNoticePdfInput } from "@/lib/pdf/eot-notice-pdf";

// PDF rendering is Node.js only — opt out of edge runtime.
export const runtime = "nodejs";

/**
 * EOT contractual NOTICE OF DELAY, per delay event.
 *
 *   GET /api/delays/[id]/notice/pdf
 *
 * RLS-scoped via the user JWT (requireOrgContext), and the EVENT is pinned to
 * the ACTIVE org inside loadEotNotice: "RLS admits it" is not scoping —
 * current_org_ids() spans every org a dual-org member belongs to, so a foreign
 * event id must 404 exactly as a missing one does (the invoice-pdf lesson).
 *
 * RECORDED-ONLY: a notice is raised from a recorded event only. A draft is a
 * half-written account and a withdrawn event is retracted — both return 409, not
 * an official-looking document.
 *
 * On-demand and INTERNAL: private no-store headers, never cached, never stored,
 * never sent anywhere by the system. It is a DRAFT for a human to review,
 * complete ([not specified] fields) and issue.
 */
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { ctx } = await requireOrgContext();
  const { id } = await params;

  const result = await loadEotNotice(ctx.org.id, id);
  if (!result.ok) {
    return result.reason === "not_found"
      ? NextResponse.json({ error: "Not found" }, { status: 404 })
      : NextResponse.json(
          { error: "A notice can only be generated from a recorded delay event" },
          { status: 409 },
        );
  }

  const input: EotNoticePdfInput = { notice: result.notice };
  const buffer = await renderToBuffer(EotNoticePdf({ input }));
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="eot-notice-${result.notice.reference.replace("/", "-")}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
