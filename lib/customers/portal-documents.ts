/**
 * Customer portal — the document library (pure).
 *
 * Aggregates the customer's PDF-backed commercial documents (quotes, invoices,
 * progress reports) into ONE typed, date-sorted library. Deliberately limited
 * to document types that ALREADY carry an explicit customer-visibility gate
 * upstream (quotes cleared the approval gate; invoices are customer-anchored;
 * reports are published + non-withdrawn) — arbitrary job attachments are NOT
 * included because `tenant_attachments` has no portal-visibility flag, and the
 * portal rule is that internal docs must never appear merely by sharing a job.
 *
 * Pure — the caller passes already-scoped rows; no clocks, no IO.
 */

export type PortalDocType = "quote" | "invoice" | "report";

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

  // Newest first; stable tie-break by title.
  return docs.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : a.title.localeCompare(b.title)));
}
