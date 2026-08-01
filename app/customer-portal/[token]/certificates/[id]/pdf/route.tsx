import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { loadCustomerByPortalToken } from "@/app/customer-portal/_helpers";
import { loadPortalCertificate } from "@/app/customer-portal/_certificates";
import { createAdminClient } from "@/lib/supabase/admin";
import { CompletionCertificatePdf } from "@/lib/pdf/completion-certificate-pdf";
import { safeReportFilename } from "@/lib/site-reports/portal";

// react-pdf renders on Node.
export const runtime = "nodejs";

type Ctx = { params: Promise<{ token: string; id: string }> };

/** Letterhead source — mirrors the columns the individual invoice/quote PDF
 *  routes read from `organizations`. `address` is the single jsonb blob
 *  ({ line1?, city?, postcode? }); there are NO flat address columns on this
 *  table, so the letterhead is derived from the jsonb. */
type OrgRow = {
  name: string | null;
  logo_url: string | null;
  address: { line1?: string; city?: string; postcode?: string } | null;
};

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
  // Org letterhead. `organizations` carries a single `address` jsonb blob
  // ({ line1?, city?, postcode? }) — the same shape the invoice/quote PDF routes
  // consume; there are NO flat address columns on this table. Read LOUDLY: a
  // failed org read must not silently render a certificate with a blank
  // letterhead, so a query error is a 500, not a fall-back to {}.
  const { data: org, error: orgError } = await (
    admin.from("organizations") as unknown as {
      select: (c: string) => { eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: OrgRow | null; error: unknown }> } };
    }
  )
    .select("name, logo_url, address")
    .eq("id", loaded.org.id)
    .maybeSingle();
  if (orgError) return NextResponse.json({ error: "query_failed" }, { status: 500 });
  const orgRow = (org ?? {}) as OrgRow;
  const orgName = orgRow.name ?? loaded.org.name ?? "Contractor";
  const addr = orgRow.address ?? null;
  const orgBlockLines = [addr?.line1, [addr?.city, addr?.postcode].filter(Boolean).join(" ")]
    .filter((l): l is string => Boolean(l && l.trim()));

  const buffer = await renderToBuffer(
    <CompletionCertificatePdf
      c={{ orgName, orgBlockLines, logoUrl: orgRow.logo_url ?? null, snapshot: cert.snapshot, isDraft: false }}
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
