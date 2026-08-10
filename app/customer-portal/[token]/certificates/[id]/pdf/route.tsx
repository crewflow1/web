import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { loadCustomerByPortalToken } from "@/app/customer-portal/_helpers";
import { loadPortalCertificate } from "@/app/customer-portal/_certificates";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { resolveOrgLogoSrc } from "@/server/services/company-logo";
import { CompletionCertificatePdf } from "@/lib/pdf/completion-certificate-pdf";
import { safeReportFilename } from "@/lib/site-reports/portal";

// react-pdf renders on Node.
export const runtime = "nodejs";

type Ctx = { params: Promise<{ token: string; id: string }> };

/**
 * Customer-portal completion-certificate PDF.
 *
 *   GET /customer-portal/[token]/certificates/[id]/pdf
 *
 * Verified on EVERY request: the token resolves to a customer
 * (loadCustomerByPortalToken — the single token authority), and
 * loadPortalCertificate enforces customer_id + org_id + visibility. A 404 is
 * returned for any cert that isn't the customer's own, published, non-withdrawn
 * issued cert — so id-guessing, a withdrawn cert, or a draft all fail
 * identically. Rendered from the FROZEN customer-safe snapshot only.
 */
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { token, id } = await params;

  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) return NextResponse.json({ error: "Not available" }, { status: 404 });

  const cert = await loadPortalCertificate(loaded.customer.id, loaded.org.id, id);
  if (!cert || !cert.snapshot) return NextResponse.json({ error: "Not available" }, { status: 404 });

  const admin = createAdminClient();
  // `organizations` has NO flat address columns — the letterhead address is a
  // single jsonb blob ({ line1?, city?, postcode? }), the same shape the
  // invoice/quote PDFs and the bulk-download certificate render consume. The
  // logo is either an uploaded object (logo_path → signed URL) or a legacy
  // external URL (logo_url); resolveOrgLogoSrc handles both.
  type OrgBrandingRow = {
    name: string | null;
    logo_url: string | null;
    logo_path: string | null;
    address: { line1?: string; city?: string; postcode?: string } | null;
  };
  const { data: org, error: orgError } = await (
    admin.from("organizations") as unknown as {
      select: (c: string) => { eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: OrgBrandingRow | null; error: SupabaseReadError | null }> } };
    }
  )
    .select("name, logo_url, logo_path, address")
    .eq("id", loaded.org.id)
    .maybeSingle();
  // A branding read FAILURE must not silently degrade to a blank letterhead on a
  // contractual document — fail loud (mirrors portal-bulk-download's loud reads).
  if (orgError) throw readFailure("portal certificate: org branding", orgError);
  const orgRow = (org ?? {}) as OrgBrandingRow;
  const orgName = orgRow.name ?? loaded.org.name ?? "Contractor";
  const addr = orgRow.address ?? null;
  const orgBlockLines = [
    addr?.line1,
    [addr?.city, addr?.postcode].filter(Boolean).join(" "),
  ].filter((l): l is string => Boolean(l && l.trim()));
  const logoUrl = await resolveOrgLogoSrc(
    { logo_path: orgRow.logo_path, logo_url: orgRow.logo_url },
    admin,
  );

  const buffer = await renderToBuffer(
    <CompletionCertificatePdf
      c={{ orgName, orgBlockLines, logoUrl, snapshot: cert.snapshot, isDraft: false }}
    />,
  );
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${safeReportFilename(cert.certificate_number, "certificate")}"`,
      "Cache-Control": "private, max-age=300",
    },
  });
}
