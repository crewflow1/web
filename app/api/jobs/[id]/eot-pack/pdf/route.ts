import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { loadEotEvidencePack } from "@/server/services/eot-pack";
import { EotPackPdf, type EotPackPdfInput } from "@/lib/pdf/eot-pack-pdf";

// PDF rendering is Node.js only — opt out of edge runtime.
export const runtime = "nodejs";

/**
 * EOT evidence pack PDF.
 *
 *   GET /api/jobs/[id]/eot-pack/pdf
 *
 * RLS-scoped via the user JWT (requireOrgContext), and the JOB is pinned to
 * the ACTIVE org here: "RLS admits it" is not scoping — current_org_ids()
 * spans every org a dual-org member belongs to, so a foreign job id must 404
 * exactly as a missing one does (the invoice-pdf lesson).
 *
 * RECORDED EVENTS ONLY: the pack shape (lib/eot/pack.ts) excludes drafts and
 * withdrawn events by construction — this route cannot render them because
 * they are not in the structure it receives. 409 when nothing is recorded: a
 * pack with zero recorded events is not evidence, and producing an official-
 * looking empty document would imply the job ran clean.
 *
 * On-demand and INTERNAL: private no-store headers, never cached, never
 * stored, never sent anywhere by the system. Human review is the point.
 */
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { ctx } = await requireOrgContext();
  const { id } = await params;
  const supabase = await createClient();

  // Pin the job to the ACTIVE org, and take the letterhead from that same
  // org row — the one RLS + the pin just proved the caller is working in.
  const { data: job, error: jErr } = await supabase
    .from("jobs")
    .select("id, scheduled_date, customer:customers ( name ), org:organizations ( name )")
    .eq("id", id)
    .eq("org_id", ctx.org.id)
    .maybeSingle();
  if (jErr) {
    console.error("[eot-pack-pdf] job load failed", jErr);
    return NextResponse.json({ error: "Failed to load job" }, { status: 500 });
  }
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { pack, failed } = await loadEotEvidencePack(ctx.org.id, id);
  // A pack assembled over a failed read is not evidence — refuse loudly
  // rather than print a document that silently omits events.
  if (failed) {
    return NextResponse.json({ error: "Failed to load delay evidence" }, { status: 500 });
  }
  if (pack.recordedEventCount === 0) {
    return NextResponse.json({ error: "No recorded delay events" }, { status: 409 });
  }

  const customer = (job as unknown as { customer: { name: string | null } | null }).customer;
  const org = (job as unknown as { org: { name: string | null } | null }).org;
  const jobLabel = [customer?.name ?? "Job", job.scheduled_date ?? null]
    .filter(Boolean)
    .join(" · ");

  const input: EotPackPdfInput = {
    org_name: org?.name ?? ctx.org.name ?? "CrewFlow",
    job_label: jobLabel,
    pack,
  };

  const buffer = await renderToBuffer(EotPackPdf({ input }));
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="eot-evidence-pack.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
