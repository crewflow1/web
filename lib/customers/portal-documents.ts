/**
 * Customer portal — the document library (pure).
 *
 * Aggregates the customer's PDF-backed commercial documents (quotes, invoices,
 * progress reports) into ONE typed, date-sorted library. Deliberately limited
 * to document types that ALREADY carry an explicit customer-visibility gate
 * upstream (quotes cleared the approval gate; invoices are customer-anchored;
 * reports are published + non-withdrawn).
 *
 * ATTACHMENTS — a job/quote attachment reaches this library ONLY when a staff
 * member has explicitly set `tenant_attachments.portal_visible = true` on it AND
 * it resolves to an entity the customer owns (the caller enforces both — see
 * app/customer-portal/_attachments.ts). The flag defaults FALSE, so nothing is
 * shared merely by attaching it to a job. Without an explicit flag the portal
 * rule still holds: internal docs never appear just because a job is shared.
 *
 * Pure — the caller passes already-scoped rows; no clocks, no IO.
 */

export type PortalDocType =
  | "quote"
  | "invoice"
  | "report"
  | "certificate"
  | "attachment";

export type PortalDocument = {
  type: PortalDocType;
  /** ISO date used for sorting + display. */
  date: string;
  title: string;
  sub: string;
  /** In-portal view (or /q/<token> for quotes); may be null for report-only. */
  viewHref: string | null;
  /** Secure PDF download. */
  pdfHref: string;
};

export const PORTAL_DOC_TYPE_LABELS: Record<PortalDocType, string> = {
  quote: "Quote",
  invoice: "Invoice",
  report: "Report",
  certificate: "Certificate",
  attachment: "Attachment",
};

export type LibQuote = {
  id: string;
  number: string | null;
  status: string;
  total: number | string | null;
  sent_at: string | null;
  accepted_at: string | null;
  public_token: string | null;
};
export type LibInvoice = {
  id: string;
  number: string | null;
  status: string;
  total: number | string | null;
  sent_at: string | null;
  created_at?: string | null;
};
export type LibReport = {
  id: string;
  report_number: string | null;
  title: string;
  issued_at: string | null;
  portal_published_at: string | null;
};
export type LibCertificate = {
  id: string;
  certificate_number: string;
  completion_date: string | null;
  issued_at: string | null;
  portal_published_at: string | null;
};
/** A portal-visible attachment, already scoped to the customer by the caller. */
export type LibAttachment = {
  id: string;
  filename: string | null;
  /** The kind of record it hangs off (job / quote / invoice …), for the subtitle. */
  target_table: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: string | null;
};

const ATTACHMENT_SOURCE_LABELS: Record<string, string> = {
  jobs: "Job attachment",
  quotes: "Quote attachment",
  invoices: "Invoice attachment",
};

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

function isoDate(v: string | null | undefined): string {
  return (v ?? "").slice(0, 10);
}

export function buildDocumentLibrary(input: {
  token: string;
  quotes: LibQuote[];
  invoices: LibInvoice[];
  reports: LibReport[];
  certificates?: LibCertificate[];
  attachments?: LibAttachment[];
}): PortalDocument[] {
  const { token } = input;
  const docs: PortalDocument[] = [];

  // Quotes the portal already surfaces (a public token = it cleared the gate).
  for (const q of input.quotes) {
    if (!q.public_token) continue;
    docs.push({
      type: "quote",
      date: isoDate(q.accepted_at ?? q.sent_at),
      title: `Quote ${q.number ?? ""}`.trim(),
      sub: `${GBP.format(Number(q.total ?? 0))} · ${q.status}`,
      viewHref: `/q/${q.public_token}`,
      pdfHref: `/q/${q.public_token}/pdf`,
    });
  }

  for (const inv of input.invoices) {
    docs.push({
      type: "invoice",
      date: isoDate(inv.sent_at ?? inv.created_at),
      title: `Invoice ${inv.number ?? ""}`.trim(),
      sub: `${GBP.format(Number(inv.total ?? 0))} · ${inv.status}`,
      viewHref: `/customer-portal/${token}/invoices`,
      pdfHref: `/customer-portal/${token}/invoices/${inv.id}/pdf`,
    });
  }

  for (const r of input.reports) {
    docs.push({
      type: "report",
      date: isoDate(r.issued_at ?? r.portal_published_at),
      title: r.title,
      sub: r.report_number ? `Report ${r.report_number}` : "Progress report",
      viewHref: `/customer-portal/${token}/reports/${r.id}`,
      pdfHref: `/customer-portal/${token}/reports/${r.id}/pdf`,
    });
  }

  for (const cert of input.certificates ?? []) {
    docs.push({
      type: "certificate",
      date: isoDate(cert.issued_at ?? cert.portal_published_at),
      title: `Completion certificate ${cert.certificate_number}`.trim(),
      sub: cert.completion_date ? `Practical completion ${cert.completion_date}` : "Practical Completion Certificate",
      viewHref: `/customer-portal/${token}/certificates/${cert.id}/pdf`,
      pdfHref: `/customer-portal/${token}/certificates/${cert.id}/pdf`,
    });
  }

  // Attachments a staff member explicitly flagged portal-visible (the caller
  // has already verified org + customer ownership). The file is served through
  // a dedicated, ownership-re-checking download route — never a raw path.
  for (const att of input.attachments ?? []) {
    const source = att.target_table
      ? (ATTACHMENT_SOURCE_LABELS[att.target_table] ?? "Attachment")
      : "Attachment";
    const size = att.size_bytes ? ` · ${formatBytes(att.size_bytes)}` : "";
    docs.push({
      type: "attachment",
      date: isoDate(att.created_at),
      title: att.filename ?? "File",
      sub: `${source}${size}`,
      viewHref: null,
      pdfHref: `/customer-portal/${token}/documents/attachments/${att.id}`,
    });
  }

  // Newest first; stable tie-break by title.
  return docs.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.title.localeCompare(b.title)));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
