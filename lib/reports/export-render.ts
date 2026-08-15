import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import { ReportPdf, type ReportPdfOrg } from "@/lib/pdf/report-pdf";
import type { ReportDocument } from "./documents";
import type { ReportsDb } from "./aggregates";

/**
 * SHARED RENDER — the ONE place a ReportDocument becomes a downloadable/
 * emailable artifact, so the on-demand export route and the scheduled delivery
 * cron produce byte-identical output.
 */

/**
 * Load the org's letterhead (name, phone, VAT, logo, address) for the PDF
 * header. ACTIVE-org pinned: an unfiltered read would, for a multi-org user,
 * let PostgREST return whichever org row comes back first — the PDF could carry
 * the wrong company's identity (the site-report PDF discipline).
 */
export async function loadReportOrg(client: ReportsDb, orgId: string): Promise<ReportPdfOrg> {
  const { data: org } = await client
    .from("organizations")
    .select("name, phone, vat_number, logo_url, address")
    .eq("id", orgId)
    .maybeSingle();
  return {
    name: (org as { name?: string | null } | null)?.name ?? "CrewFlow",
    phone: (org as { phone?: string | null } | null)?.phone ?? null,
    vat_number: (org as { vat_number?: string | null } | null)?.vat_number ?? null,
    logo_url: (org as { logo_url?: string | null } | null)?.logo_url ?? null,
    address: (org as { address?: ReportPdfOrg["address"] } | null)?.address ?? null,
  };
}

/** Render a report document to a PDF buffer. Node runtime only. */
export async function renderReportPdf(doc: ReportDocument, org: ReportPdfOrg): Promise<Buffer> {
  return renderToBuffer(ReportPdf({ doc, org }));
}

/** A stable, filesystem-safe filename stem for a report on a given day. */
export function reportFilenameStem(key: string, generatedAtIso: string): string {
  const stamp = generatedAtIso.slice(0, 10);
  return `crewflow-${key}-report-${stamp}`;
}
