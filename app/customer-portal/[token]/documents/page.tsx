import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { loadCustomerByPortalToken } from "../../_helpers";
import { listPortalReports } from "@/app/customer-portal/_reports";
import { listPortalCertificates } from "@/app/customer-portal/_certificates";
import { PortalShell } from "../_shell";
import { InvalidLinkPage } from "@/app/_components/invalid-link";
import {
  buildDocumentLibrary,
  PORTAL_DOC_TYPE_LABELS,
  type LibInvoice,
  type LibQuote,
  type PortalDocType,
} from "@/lib/customers/portal-documents";

export const metadata = { title: "Documents · CrewFlow" };

const TYPE_STYLES: Record<PortalDocType, string> = {
  quote: "bg-blue-100 text-blue-700",
  invoice: "bg-emerald-100 text-emerald-800",
  report: "bg-purple-100 text-purple-700",
  certificate: "bg-amber-100 text-amber-800",
};

/**
 * Customer portal — the document library. One place for every PDF-backed
 * commercial document (quotes, invoices, progress reports) this customer can
 * see. Each type is loaded with the SAME scoped read its own tab uses
 * (org_id + customer_id; reports via the published-visibility helper) — no new
 * visibility surface, no arbitrary attachments.
 */
export default async function PortalDocumentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ type?: string }>;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) return <InvalidLinkPage kind="portal" />;
  const { customer, org } = loaded;
  const admin = createAdminClient();

  const { data: quotesData, error: quotesError } = await admin
    .from("quotes")
    .select("id, number, status, total, sent_at, accepted_at, public_token")
    .eq("org_id", customer.org_id)
    .eq("customer_id", customer.id)
    .in("status", ["approved", "sent", "viewed", "accepted", "declined", "expired"])
    .order("created_at", { ascending: false })
    .limit(100);
  if (quotesError) {
    throw readFailure("portal documents: quotes", quotesError);
  }

  const { data: invoicesData, error: invoicesError } = await admin
    .from("invoices")
    .select("id, number, status, total, sent_at, created_at")
    .eq("org_id", customer.org_id)
    .eq("customer_id", customer.id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (invoicesError) {
    throw readFailure("portal documents: invoices", invoicesError);
  }

  const reports = await listPortalReports(customer.id, customer.org_id);
  const certRows = await listPortalCertificates(customer.id, customer.org_id);

  const documents = buildDocumentLibrary({
    token,
    quotes: (quotesData ?? []) as LibQuote[],
    invoices: (invoicesData ?? []) as LibInvoice[],
    reports,
    certificates: certRows.map((c) => ({
      id: c.id,
      certificate_number: c.certificate_number,
      completion_date: c.snapshot?.completion_date ?? null,
      issued_at: c.issued_at,
      portal_published_at: c.portal_published_at,
    })),
  });

  const filter = (["quote", "invoice", "report", "certificate"] as const).includes(sp.type as PortalDocType)
    ? (sp.type as PortalDocType)
    : null;
  const shown = filter ? documents.filter((d) => d.type === filter) : documents;

  return (
    <PortalShell customer={customer} org={org} token={token} active="documents">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">Documents</h2>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500">{documents.length} total</span>
          {shown.length > 0 ? (
            <a
              href={
                filter
                  ? `/customer-portal/${token}/documents/download-all?type=${filter}`
                  : `/customer-portal/${token}/documents/download-all`
              }
              className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
            >
              {filter
                ? `Download all ${PORTAL_DOC_TYPE_LABELS[filter].toLowerCase()}s (zip)`
                : "Download all (zip)"}
            </a>
          ) : null}
        </div>
      </div>

      <nav aria-label="Filter documents" className="flex flex-wrap gap-2 text-xs">
        <FilterLink token={token} current={filter} value={null} label="All" />
        {(["quote", "invoice", "report"] as const).map((t) => (
          <FilterLink key={t} token={token} current={filter} value={t} label={`${PORTAL_DOC_TYPE_LABELS[t]}s`} />
        ))}
      </nav>

      {shown.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
          <p className="text-3xl">📄</p>
          <p className="mt-2 text-sm font-medium text-slate-900">No documents yet</p>
          <p className="mt-1 text-sm text-slate-500">
            Quotes, invoices and progress reports from {org.name} will appear here.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {shown.map((d, i) => (
            <li
              key={`${d.type}-${i}`}
              className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${TYPE_STYLES[d.type]}`}>
                {PORTAL_DOC_TYPE_LABELS[d.type]}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-900">{d.title}</p>
                <p className="text-xs text-slate-500">
                  {d.sub}
                  {d.date ? ` · ${d.date}` : ""}
                </p>
              </div>
              <div className="ml-auto flex items-center gap-2">
                {d.viewHref ? (
                  <Link
                    href={d.viewHref}
                    {...(d.viewHref.startsWith("/q/") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    View
                  </Link>
                ) : null}
                <a
                  href={d.pdfHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                >
                  PDF
                </a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </PortalShell>
  );
}

function FilterLink({
  token,
  current,
  value,
  label,
}: {
  token: string;
  current: PortalDocType | null;
  value: PortalDocType | null;
  label: string;
}) {
  const active = current === value;
  const href = value
    ? `/customer-portal/${token}/documents?type=${value}`
    : `/customer-portal/${token}/documents`;
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`rounded-full px-3 py-1 font-medium ${
        active ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
      }`}
    >
      {label}
    </Link>
  );
}
