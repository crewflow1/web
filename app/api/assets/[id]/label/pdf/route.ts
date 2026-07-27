import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { AssetLabelPdf, type AssetLabelInput } from "@/lib/pdf/asset-label-pdf";
import { safeLabelFilename, scanPath } from "@/lib/assets/qr";

// react-pdf renders on Node.
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

type AssetRow = {
  id: string;
  name: string;
  asset_ref: string | null;
  category: string | null;
  serial_number: string | null;
  registration: string | null;
};

/**
 * GET /api/assets/[id]/label/pdf?copies=N — a printable QR label sheet.
 *
 * RLS-scoped via the user JWT. Encodes the asset's ACTIVE QR token as an
 * absolute scan URL (so a phone camera opens the authenticated /a/[token]
 * route). Only safe/public fields reach the label — never price/value/supplier
 * pricing/notes. 404 (no leak) if the asset isn't the caller's or has no active
 * identity yet.
 */
export async function GET(request: NextRequest, { params }: Ctx) {
  await requireOrgContext();
  const { id } = await params;
  const supabase = await createClient();

  const { data: asset } = await (
    supabase.from("assets" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: AssetRow | null }> };
      };
    }
  )
    .select("id, name, asset_ref, category, serial_number, registration")
    .eq("id", id)
    .maybeSingle();
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: identity } = await (
    supabase.from("asset_qr_identities" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          eq: (k: string, v: unknown) => {
            maybeSingle: () => Promise<{ data: { token: string } | null }>;
          };
        };
      };
    }
  )
    .select("token")
    .eq("asset_id", id)
    .eq("active", true)
    .maybeSingle();
  if (!identity?.token) {
    return NextResponse.json({ error: "No active QR identity" }, { status: 404 });
  }

  const { data: org } = await supabase.from("organizations").select("name").maybeSingle();

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://crewflow.uk").replace(/\/+$/, "");
  const label: AssetLabelInput = {
    org_name: org?.name ?? "CrewFlow",
    asset_name: asset.name,
    asset_ref: asset.asset_ref,
    category: asset.category,
    serial_number: asset.serial_number,
    registration: asset.registration,
    scan_url: `${appUrl}${scanPath(identity.token)}`,
  };

  const copiesRaw = Number(request.nextUrl.searchParams.get("copies") ?? "1");
  const copies = Number.isFinite(copiesRaw) ? Math.max(1, Math.min(60, Math.floor(copiesRaw))) : 1;

  const buffer = await renderToBuffer(AssetLabelPdf({ label, copies }));

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${safeLabelFilename(asset.name, asset.asset_ref)}"`,
      "Cache-Control": "private, max-age=60",
    },
  });
}
