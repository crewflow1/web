import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { loadSiteForOrg, type SitesClient } from "@/server/services/sites";
import { formatSiteAddress, siteIdSchema } from "@/lib/sites/schema";
import { buildMusterRoll } from "@/app/(app)/site-compliance/_data";
import { musterPeople, musterFilename } from "@/lib/site-compliance/export";
import { MusterRollPdf, type MusterRollPdfInput } from "@/lib/pdf/muster-roll-pdf";

export const runtime = "nodejs";

/**
 * Fire muster roll PDF. RLS-scoped AND pinned to the active org: RLS admits every
 * org the viewer belongs to, so the site is re-read with `.eq("org_id", ctx.org.id)`
 * (via loadSiteForOrg) — a multi-org member active in org A must not pull org B's
 * muster. Mirrors the toolbox-talks PDF route.
 */
type Ctx = { params: Promise<{ siteId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { siteId } = await params;
  if (!siteIdSchema.safeParse(siteId).success) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const site = await loadSiteForOrg<{ id: string; name: string; address_line1: string | null; address_line2: string | null; city: string | null; county: string | null; postcode: string | null; country: string | null }>(
    supabase as unknown as SitesClient,
    ctx.org.id,
    siteId,
    "id, name, address_line1, address_line2, city, county, postcode, country",
  );
  if (!site) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Label the export with the SUBJECT's own org (RLS already proved membership).
  const orgRow = await (supabase as unknown as { from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { maybeSingle: () => Promise<{ data: { name: string } | null }> } } } })
    .from("organizations")
    .select("name")
    .eq("id", ctx.org.id)
    .maybeSingle();

  const roll = await buildMusterRoll(ctx.org.id, siteId);
  const input: MusterRollPdfInput = {
    org_name: orgRow.data?.name ?? "CrewFlow",
    site_name: site.name,
    site_address: formatSiteAddress(site) || null,
    generated_at: roll.generatedAt,
    present_count: roll.presentCount,
    people: musterPeople(roll),
  };

  const buffer = await renderToBuffer(MusterRollPdf({ m: input }));
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${musterFilename(site.name, roll.generatedAt, "pdf")}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
