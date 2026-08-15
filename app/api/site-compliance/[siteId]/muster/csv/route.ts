import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { loadSiteForOrg, type SitesClient } from "@/server/services/sites";
import { siteIdSchema } from "@/lib/sites/schema";
import { buildMusterRoll } from "@/app/(app)/site-compliance/_data";
import { musterToCsv, musterFilename } from "@/lib/site-compliance/export";

export const runtime = "nodejs";

/**
 * Fire muster roll CSV. Same active-org pin as the PDF route — the site is
 * re-read scoped to ctx.org.id so a multi-org member cannot export another org's
 * muster.
 */
type Ctx = { params: Promise<{ siteId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { siteId } = await params;
  if (!siteIdSchema.safeParse(siteId).success) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const { ctx } = await requireOrgContext();
  const supabase = await createClient();

  const site = await loadSiteForOrg<{ id: string; name: string }>(
    supabase as unknown as SitesClient,
    ctx.org.id,
    siteId,
    "id, name",
  );
  if (!site) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const roll = await buildMusterRoll(ctx.org.id, siteId);
  const csv = musterToCsv(roll, { siteName: site.name, generatedAt: roll.generatedAt });

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${musterFilename(site.name, roll.generatedAt, "csv")}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
