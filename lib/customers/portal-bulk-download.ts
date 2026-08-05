import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { resolveOrgLogoSrc } from "@/server/services/company-logo";
import { invoiceCustomerId } from "@/lib/invoices/customer";
import { InvoicePdf, type InvoicePdfInput } from "@/lib/pdf/invoice-pdf";
import { QuotePdf, type QuotePdfInput } from "@/lib/pdf/quote-pdf";
import { SiteReportPdf, type SiteReportPdfInput } from "@/lib/pdf/site-report-pdf";
import { CompletionCertificatePdf } from "@/lib/pdf/completion-certificate-pdf";
import type { DiaryLite, SnagLite, ToolboxLite } from "@/lib/site-reports/aggregate";
import { listPortalReports, loadPortalReport } from "@/app/customer-portal/_reports";
import { listPortalCertificates, loadPortalCertificate } from "@/app/customer-portal/_certificates";
import type { PortalCustomer, PortalOrg } from "@/app/customer-portal/_helpers";
import {
  buildBulkPlan,
  MAX_BULK_DOCS,
  type BulkPlanItem,
} from "./portal-bulk-plan";
import type { PortalDocType } from "./portal-documents";

/**
 * Customer portal — bulk (zip) download COLLECTOR (server-only).
 *
 * Renders every one of the token-resolved customer's OWN commercial PDFs
 * (quotes / invoices / reports / certificates) so the route can stream them as a
 * single zip. It is the security-critical half of the bulk download; the
 * ordering/bounds/filename half is the pure `portal-bulk-plan`.
 *
 * SCOPING — the whole point. The caller has already resolved the URL token to a
 * customer (the ONE authority, loadCustomerByPortalToken). This collector takes
 * that resolved { customer, org } and NEVER a client-supplied id list, so a
 * customer can only ever receive their own documents:
 *   - invoices & quotes: read on the RLS-bypassing admin client, scoped in code
 *     by BOTH `.eq("org_id", customer.org_id)` AND `.eq("customer_id",
 *     customer.id)`, then EACH row re-verified (org match + invoiceCustomerId /
 *     quote.customer_id) before it is rendered — defence-in-depth over the SQL;
 *   - reports & certificates: delegated to the existing scoped portal loaders
 *     (listPortalReports / loadPortalReport, listPortalCertificates /
 *     loadPortalCertificate) which enforce customer_id + org_id + the
 *     issued/published/not-withdrawn visibility rule and return only the frozen
 *     customer-safe snapshot.
 *
 * BOUNDS. `buildBulkPlan` caps the count (MAX_BULK_DOCS); this collector also
 * enforces a total-bytes ceiling while rendering, so no runaway document set can
 * balloon memory. Either cap trips `capped`.
 *
 * Loud reads: a query FAILURE throws (readFailure / the loaders) — it never
 * degrades into an empty or partial zip that would look like "you have no
 * documents". A row that is simply not the customer's own is skipped silently
 * (it should never have been in a scoped result in the first place).
 */

/** Total uncompressed byte ceiling across all rendered PDFs in one zip. Renders
 *  stop once this is exceeded and the result is marked `capped`. */
export const MAX_BULK_TOTAL_BYTES = 45 * 1024 * 1024;

export type BulkFile = { filename: string; bytes: Uint8Array };

export type BulkResult = {
  files: BulkFile[];
  /** True when the count cap OR the byte cap truncated the set. */
  capped: boolean;
  /** Documents that matched the (optional) filter before any cap. */
  total: number;
};

type InvoiceRow = {
  id: string;
  number: string | null;
  status: string;
  amount: number | string | null;
  vat_total: number | string | null;
  total: number | string | null;
  due_date: string | null;
  paid_at: string | null;
  notes: string | null;
  sent_at: string | null;
  created_at: string | null;
  quote_id: string | null;
  org_id: string;
  customer_id: string | null;
  quote: { customer_id: string | null; customer: { name: string | null } | null } | null;
};

type QuoteRow = {
  id: string;
  number: string | null;
  status: string;
  subtotal: number | string | null;
  vat_total: number | string | null;
  total: number | string | null;
  valid_until: string | null;
  eot_requested_completion_date: string | null;
  eot_agreed_completion_date: string | null;
  notes: string | null;
  terms: string | null;
  sent_at: string | null;
  accepted_at: string | null;
  org_id: string;
  customer_id: string | null;
  public_token: string | null;
};

/** Letterhead source — mirrors the columns the individual invoice/quote PDF
 *  routes read from `organizations`. `address` is the single jsonb blob
 *  ({ line1?, city?, postcode? }); there are NO flat address columns on this
 *  table, so the letterhead is derived from the jsonb. */
type OrgRow = {
  name: string | null;
  phone: string | null;
  vat_number: string | null;
  logo_path: string | null;
  logo_url: string | null;
  address: { line1?: string; city?: string; postcode?: string } | null;
  bank_details: unknown;
};

function isoDate(v: string | null | undefined): string {
  return (v ?? "").slice(0, 10);
}

/**
 * Collect the customer's own document PDFs into an ordered, bounded set ready to
 * zip. `filter`, when set, restricts to a single category (the ONLY input this
 * accepts beyond the token-resolved identity — no ids).
 */
export async function collectPortalDocumentPdfs(args: {
  customer: PortalCustomer;
  org: PortalOrg;
  filter?: PortalDocType | null;
}): Promise<BulkResult> {
  const { customer, org } = args;
  const filter = args.filter ?? null;
  const admin = createAdminClient();

  // Shared org details (logo signed ONCE, not per document).
  const { data: orgRow, error: orgError } = await admin
    .from("organizations")
    .select("name, phone, vat_number, logo_path, logo_url, address, bank_details")
    .eq("id", customer.org_id)
    .maybeSingle();
  if (orgError) throw readFailure("portal bulk: org", orgError);
  const orgData = (orgRow ?? {}) as OrgRow;
  const orgLogo = await resolveOrgLogoSrc(
    { logo_path: orgData.logo_path, logo_url: orgData.logo_url },
    admin,
  );

  // --- Scoped reads: EVERY doc set is filtered to this customer + org. ---------
  const { data: invoiceData, error: invoiceError } = await admin
    .from("invoices")
    .select(
      `
        id, number, status, amount, vat_total, total, due_date, paid_at, notes,
        sent_at, created_at, quote_id, org_id, customer_id,
        quote:quotes ( customer_id, customer:customers ( name ) )
      `,
    )
    .eq("org_id", customer.org_id)
    .eq("customer_id", customer.id)
    .order("created_at", { ascending: false })
    .limit(200);
  if (invoiceError) throw readFailure("portal bulk: invoices", invoiceError);

  const { data: quoteData, error: quoteError } = await admin
    .from("quotes")
    .select(
      `
        id, number, status, subtotal, vat_total, total, valid_until,
        eot_requested_completion_date, eot_agreed_completion_date, notes, terms,
        sent_at, accepted_at, org_id, customer_id, public_token
      `,
    )
    .eq("org_id", customer.org_id)
    .eq("customer_id", customer.id)
    .not("public_token", "is", null)
    // Match the documents-library page's visibility exactly: a draft quote
    // must not appear in the bulk zip when it is hidden from the on-screen
    // list (adversarial P2 — surface consistency; it is still the customer's
    // own quote, individually reachable via /q/<token>/pdf).
    .in("status", ["approved", "sent", "viewed", "accepted", "declined", "expired"])
    .order("created_at", { ascending: false })
    .limit(200);
  if (quoteError) throw readFailure("portal bulk: quotes", quoteError);

  const reports = await listPortalReports(customer.id, customer.org_id);
  const certificates = await listPortalCertificates(customer.id, customer.org_id);

  // --- Per-row ownership re-verification (defence-in-depth over the SQL). ------
  const invoices = ((invoiceData ?? []) as InvoiceRow[]).filter(
    (inv) => inv.org_id === customer.org_id && invoiceCustomerId(inv) === customer.id,
  );
  const quotes = ((quoteData ?? []) as QuoteRow[]).filter(
    (q) =>
      q.org_id === customer.org_id &&
      q.customer_id === customer.id &&
      Boolean(q.public_token),
  );

  // --- Build the ordered, bounded plan (pure). --------------------------------
  const items: BulkPlanItem[] = [
    ...quotes.map<BulkPlanItem>((q) => ({
      type: "quote",
      id: q.id,
      label: `Quote ${q.number ?? q.id}`.trim(),
      date: isoDate(q.accepted_at ?? q.sent_at),
    })),
    ...invoices.map<BulkPlanItem>((inv) => ({
      type: "invoice",
      id: inv.id,
      label: `Invoice ${inv.number ?? inv.id}`.trim(),
      date: isoDate(inv.sent_at ?? inv.created_at),
    })),
    ...reports.map<BulkPlanItem>((r) => ({
      type: "report",
      id: r.id,
      label: r.report_number ? `Report ${r.report_number}` : r.title || "Progress report",
      date: isoDate(r.issued_at ?? r.portal_published_at),
    })),
    ...certificates.map<BulkPlanItem>((c) => ({
      type: "certificate",
      id: c.id,
      label: `Completion certificate ${c.certificate_number}`.trim(),
      date: isoDate(c.issued_at ?? c.portal_published_at),
    })),
  ];

  const plan = buildBulkPlan(items, { filter, maxDocs: MAX_BULK_DOCS });

  // Fast lookup from the source rows for rendering the chosen entries.
  const invoiceById = new Map(invoices.map((i) => [i.id, i]));
  const quoteById = new Map(quotes.map((q) => [q.id, q]));

  const files: BulkFile[] = [];
  let bytes = 0;
  let byteCapped = false;

  for (const entry of plan.entries) {
    const bytesRendered = await renderEntry(entry.type, entry.id, {
      admin,
      customer,
      org,
      orgData,
      orgLogo,
      invoiceById,
      quoteById,
    });
    if (!bytesRendered) continue; // row vanished / not visible — skip, never leak.

    if (bytes + bytesRendered.length > MAX_BULK_TOTAL_BYTES && files.length > 0) {
      // Byte ceiling hit — stop before ballooning memory; keep what we have.
      byteCapped = true;
      break;
    }
    bytes += bytesRendered.length;
    files.push({ filename: entry.filename, bytes: bytesRendered });
  }

  return { files, capped: plan.capped || byteCapped, total: plan.total };
}

type RenderCtx = {
  admin: ReturnType<typeof createAdminClient>;
  customer: PortalCustomer;
  org: PortalOrg;
  orgData: OrgRow;
  orgLogo: string | null;
  invoiceById: Map<string, InvoiceRow>;
  quoteById: Map<string, QuoteRow>;
};

async function renderEntry(
  type: PortalDocType,
  id: string,
  ctx: RenderCtx,
): Promise<Uint8Array | null> {
  switch (type) {
    case "invoice":
      return renderInvoice(ctx.invoiceById.get(id) ?? null, ctx);
    case "quote":
      return renderQuote(ctx.quoteById.get(id) ?? null, ctx);
    case "report":
      return renderReport(id, ctx);
    case "certificate":
      return renderCertificate(id, ctx);
    default:
      return null;
  }
}

async function renderInvoice(inv: InvoiceRow | null, ctx: RenderCtx): Promise<Uint8Array | null> {
  if (!inv) return null;
  // Re-verify ownership at render time — the id only ever came from a scoped row,
  // but this closes the door on any future refactor that widens the source.
  if (inv.org_id !== ctx.customer.org_id || invoiceCustomerId(inv) !== ctx.customer.id) {
    return null;
  }
  // F-1: page the full snapshot — completeness matters for a bulk export; a
  // large invoice can exceed the 1000-row PostgREST cap and a clamped read
  // would zip a PDF billing only the first page. `sort_order` is the print
  // order; `id` the unique tiebreak that keeps paging deterministic.
  type LineRow = {
    description: string;
    qty: number | string | null;
    unit_price: number | string | null;
    vat_rate: number | string | null;
    line_total: number | string | null;
    sort_order: number | null;
  };
  const { data: lines, error } = await fetchAllRows<LineRow>(
    (from, to) =>
      ctx.admin
        .from("invoice_line_items")
        .select("description, qty, unit_price, vat_rate, line_total, sort_order")
        .eq("invoice_id", inv.id)
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: LineRow[] | null;
        error: unknown;
      }>,
  );
  if (error) throw readFailure("portal bulk: invoice lines", error);

  const input: InvoicePdfInput = {
    number: inv.number ?? "",
    status: inv.status,
    amount: Number(inv.amount ?? 0),
    vat_total: Number(inv.vat_total ?? 0),
    total: Number(inv.total ?? 0),
    due_date: inv.due_date,
    paid_at: inv.paid_at,
    notes: inv.notes,
    customer_name: inv.quote?.customer?.name ?? ctx.customer.name ?? null,
    org_name: ctx.orgData.name ?? ctx.org.name ?? "",
    org_phone: ctx.orgData.phone ?? null,
    org_vat_number: ctx.orgData.vat_number ?? null,
    org_logo_url: ctx.orgLogo,
    org_address: (ctx.orgData.address as InvoicePdfInput["org_address"]) ?? null,
    org_bank_details: (ctx.orgData.bank_details as InvoicePdfInput["org_bank_details"]) ?? null,
    line_items: (lines ?? []).map((li) => ({
      description: li.description,
      qty: Number(li.qty),
      unit_price: Number(li.unit_price),
      vat_rate: Number(li.vat_rate),
      line_total: Number(li.line_total),
    })),
  };
  return new Uint8Array(await renderToBuffer(InvoicePdf({ inv: input })));
}

async function renderQuote(q: QuoteRow | null, ctx: RenderCtx): Promise<Uint8Array | null> {
  if (!q) return null;
  if (q.org_id !== ctx.customer.org_id || q.customer_id !== ctx.customer.id || !q.public_token) {
    return null;
  }
  const { data: lines, error } = await ctx.admin
    .from("quote_line_items")
    .select("description, qty, unit_price, vat_rate, line_total, sort_order")
    .eq("quote_id", q.id)
    .order("sort_order", { ascending: true });
  if (error) throw readFailure("portal bulk: quote lines", error);

  const input: QuotePdfInput = {
    number: q.number ?? "",
    status: q.status,
    subtotal: Number(q.subtotal ?? 0),
    vat_total: Number(q.vat_total ?? 0),
    total: Number(q.total ?? 0),
    valid_until: q.valid_until,
    eot_requested_completion_date: q.eot_requested_completion_date,
    eot_agreed_completion_date: q.eot_agreed_completion_date,
    notes: q.notes,
    terms: q.terms,
    customer_name: ctx.customer.name ?? null,
    org_name: ctx.orgData.name ?? ctx.org.name ?? "",
    org_phone: ctx.orgData.phone ?? null,
    org_vat_number: ctx.orgData.vat_number ?? null,
    org_logo_url: ctx.orgLogo,
    org_address: (ctx.orgData.address as QuotePdfInput["org_address"]) ?? null,
    org_bank_details: (ctx.orgData.bank_details as QuotePdfInput["org_bank_details"]) ?? null,
    line_items: (lines ?? []).map((li) => ({
      description: li.description,
      qty: Number(li.qty),
      unit_price: Number(li.unit_price),
      vat_rate: Number(li.vat_rate),
      line_total: Number(li.line_total),
    })),
  };
  return new Uint8Array(await renderToBuffer(QuotePdf({ q: input })));
}

async function renderReport(id: string, ctx: RenderCtx): Promise<Uint8Array | null> {
  // Delegate to the ONE scoped portal loader (customer_id + org_id + visibility).
  const report = await loadPortalReport(ctx.customer.id, ctx.org.id, id);
  if (!report || !report.snapshot) return null;
  const snap = report.snapshot;
  const input: SiteReportPdfInput = {
    title: snap.title,
    report_number: snap.report_number,
    revision: snap.revision,
    status: report.status,
    period_start: snap.period_start,
    period_end: snap.period_end,
    customer_name: snap.customer_name,
    job_label: snap.job_label,
    issued_at: snap.issued_at,
    content: snap.content,
    diary: (snap.sources?.diary ?? []) as unknown as DiaryLite[],
    snags: (snap.sources?.snags ?? []) as unknown as SnagLite[],
    toolbox: (snap.sources?.toolbox_talks ?? []) as unknown as ToolboxLite[],
    prepared_by_name: null,
    approved_by_name: null,
    approved_at: null,
    org_name: ctx.org.name,
    org_phone: ctx.org.phone,
    org_vat_number: null,
    org_logo_url: ctx.org.logo_url,
    org_address: ctx.org.address,
  };
  return new Uint8Array(await renderToBuffer(SiteReportPdf({ r: input })));
}

async function renderCertificate(id: string, ctx: RenderCtx): Promise<Uint8Array | null> {
  const cert = await loadPortalCertificate(ctx.customer.id, ctx.org.id, id);
  if (!cert || !cert.snapshot) return null;
  const orgName = ctx.orgData.name ?? ctx.org.name ?? "Contractor";
  // The org address is a single jsonb blob ({ line1?, city?, postcode? }) — the
  // same shape the invoice/quote PDFs consume. There are no flat address columns
  // on `organizations`, so the certificate letterhead is derived from the jsonb.
  const addr = ctx.orgData.address ?? ctx.org.address ?? null;
  const orgBlockLines = [
    addr?.line1,
    [addr?.city, addr?.postcode].filter(Boolean).join(" "),
  ].filter((l): l is string => Boolean(l && l.trim()));
  return new Uint8Array(
    await renderToBuffer(
      CompletionCertificatePdf({
        c: {
          orgName,
          orgBlockLines,
          logoUrl: ctx.orgData.logo_url ?? ctx.org.logo_url ?? null,
          snapshot: cert.snapshot,
          isDraft: false,
        },
      }),
    ),
  );
}
