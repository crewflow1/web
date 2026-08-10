import { NextResponse, type NextRequest } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseReadError } from "@/lib/supabase/read-failure";
import { requireOrgContext } from "@/server/auth/session";
import { certContentSchema } from "@/lib/completion-certificates/schema";
import {
  buildCertificateSnapshot,
  type CertificateSnapshot,
} from "@/lib/completion-certificates/snapshot";
import { CompletionCertificatePdf } from "@/lib/pdf/completion-certificate-pdf";
import { resolveOrgLogoSrc } from "@/server/services/company-logo";
import { resolveJobAddress, formatAddressLines } from "@/lib/address";

// react-pdf renders on Node, not edge.
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

type CertRow = {
  id: string;
  status: string;
  job_id: string | null;
  certificate_number: string;
  content: Record<string, unknown> | null;
  snapshot: CertificateSnapshot | null;
};

/**
 * GET /api/completion-certificates/[id]/pdf — the branded PDF.
 *
 * RLS-scoped via the user JWT (requireOrgContext). An ISSUED cert renders from
 * its FROZEN customer-safe snapshot; a draft renders a live preview from current
 * content. A cross-org id resolves to null under RLS → 404 (no enumeration).
 */
export async function GET(_request: NextRequest, { params }: Ctx) {
  const { ctx } = await requireOrgContext();
  const { id } = await params;
  const supabase = await createClient();

  const { data: cert, error: certError } = await (
    supabase.from("completion_certificates" as never) as unknown as {
      select: (c: string) => { eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: CertRow | null; error: SupabaseReadError | null }> } };
    }
  )
    .select("id, status, job_id, certificate_number, content, snapshot")
    .eq("id", id)
    .maybeSingle();
  if (certError) {
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }
  if (!cert) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Org branding. `organizations` has NO flat address columns — the letterhead
  // address is a single jsonb blob ({ line1?, city?, postcode? }), the same shape
  // the invoice/quote PDFs and the bulk-download certificate render consume. The
  // logo is either an uploaded object (logo_path → signed URL) or a legacy
  // external URL (logo_url); resolveOrgLogoSrc handles both.
  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("name, logo_url, logo_path, address")
    .eq("id", ctx.org.id)
    .maybeSingle();
  // A branding read FAILURE must not silently degrade to a blank letterhead on a
  // contractual document — fail loud (mirrors the cert read above).
  if (orgError) {
    return NextResponse.json({ error: "query_failed" }, { status: 500 });
  }
  type OrgAddress = { line1?: string; city?: string; postcode?: string } | null;
  const orgRow = (org ?? {}) as {
    name: string | null;
    logo_url: string | null;
    logo_path: string | null;
    address: OrgAddress;
  };
  const addr = orgRow.address ?? null;
  const orgBlockLines = [
    addr?.line1,
    [addr?.city, addr?.postcode].filter(Boolean).join(" "),
  ].filter((l): l is string => Boolean(l && l.trim()));
  const logoUrl = await resolveOrgLogoSrc({
    logo_path: orgRow.logo_path,
    logo_url: orgRow.logo_url,
  });

  let snapshot: CertificateSnapshot | null = cert.snapshot;
  const isDraft = cert.status === "draft";
  if (isDraft) {
    // Live preview from current draft content (never persisted).
    const content = certContentSchema.safeParse(cert.content);
    if (!content.success) return NextResponse.json({ error: "Incomplete draft" }, { status: 400 });
    let customerName: string | null = null;
    let siteAddress: string | null = null;
    if (cert.job_id) {
      const { data: job } = await supabase
        .from("jobs")
        .select("id, site_address_line1, site_address_line2, site_city, site_county, site_postcode, site_country, customer:customers ( name, address_line1, address_line2, city, county, postcode, country )")
        .eq("id", cert.job_id)
        .maybeSingle();
      const jobCustomer = (job as { customer?: Record<string, unknown> } | null)?.customer ?? null;
      customerName = (jobCustomer as { name?: string } | null)?.name ?? null;
      const addr = job ? resolveJobAddress(job as never, jobCustomer as never) : null;
      siteAddress = addr ? formatAddressLines(addr).join(", ") : null;
    }
    snapshot = buildCertificateSnapshot({
      certificateNumber: cert.certificate_number,
      content: content.data,
      contractorName: ctx.org.name,
      customerName,
      jobReference: cert.job_id ? cert.job_id.slice(0, 8) : null,
      siteAddress,
      issuedByName: null,
      issuedOn: new Date().toISOString().slice(0, 10),
    });
  }
  if (!snapshot) return NextResponse.json({ error: "No snapshot" }, { status: 400 });

  const buffer = await renderToBuffer(
    <CompletionCertificatePdf
      c={{ orgName: ctx.org.name, orgBlockLines, logoUrl, snapshot, isDraft }}
    />,
  );
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${cert.certificate_number}.pdf"`,
      "Cache-Control": "private, no-store",
    },
  });
}
