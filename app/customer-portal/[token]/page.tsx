import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "../_helpers";
import { PortalShell } from "./_shell";
import { InvalidLinkPage } from "@/app/_components/invalid-link";
import { buildPortalActionItems, type PortalActionItem } from "@/lib/customers/portal-actions";

/**
 * Customer portal overview.
 *
 * Numbers reflect the actual data this customer has at the org —
 * open quotes count, total outstanding-invoice balance, and the
 * most-recent quote / invoice. RLS bypassed via service-role
 * (token is the auth surface), but every query is gated on
 * `org_id` AND `customer_id` so cross-tenant leakage is impossible
 * even if a malicious URL were crafted.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

const QUOTE_STATUS_STYLES: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  sent: "bg-blue-100 text-blue-700",
  viewed: "bg-indigo-100 text-indigo-700",
  accepted: "bg-green-100 text-green-700",
  declined: "bg-red-100 text-red-700",
  expired: "bg-slate-200 text-slate-600",
};
const INVOICE_STATUS_STYLES: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  sent: "bg-blue-100 text-blue-700",
  paid: "bg-green-100 text-green-700",
  overdue: "bg-red-100 text-red-700",
};

export default async function PortalOverviewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const loaded = await loadCustomerByPortalToken(token);
  // Tokens get rotated by the contractor whenever they want to revoke access.
  // Customers receive multiple links over time; when an old one is hit we
  // surface a friendly "request a new link" page instead of a bare 404.
  if (!loaded) return <InvalidLinkPage kind="portal" />;
  const { customer, org } = loaded;

  const admin = createAdminClient();

  // Quotes are customer-scoped at the DB (org_id + customer_id).
  //
  // SECURITY (P2 audit M-1): invoices carry no customer_id column — they
  // link to a customer only via their parent quote. The overview previously
  // read the org's most-recent invoices scoped ONLY by org_id and then
  // narrowed to this customer in JS. On the service-role client (which
  // BYPASSES RLS) that over-reads other customers' invoice rows, and the
  // org-wide `.limit(50)` can exclude this customer's own invoices entirely
  // (wrong "outstanding" total / missing recent invoice on a busy org).
  // Scope the invoices read to THIS customer's quote ids in the query
  // instead — the same per-customer scoping the invoices list page uses.
  const { data: quotesData } = await admin
    .from("quotes")
    .select("id, number, status, total, valid_until, sent_at, accepted_at, public_token")
    .eq("org_id", customer.org_id)
    .eq("customer_id", customer.id)
    .order("created_at", { ascending: false })
    .limit(50);
  const allQuotes = quotesData ?? [];

  // Scope invoices by their own customer anchor (Issue #349 Phase 1), not via
  // quote_id — authoritative and survives quote loss (see the invoices page).
  const { data: invoicesData } = await admin
    .from("invoices")
    .select(
      "id, number, status, amount, vat_total, total, due_date, sent_at, paid_at",
    )
    .eq("org_id", customer.org_id)
    .eq("customer_id", customer.id)
    .order("created_at", { ascending: false })
    .limit(50);
  const invoices: Array<{
    id: string;
    number: string;
    status: string;
    amount: number | string | null;
    vat_total: number | string | null;
    total: number | string | null;
    due_date: string | null;
    sent_at: string | null;
    paid_at: string | null;
  }> = invoicesData ?? [];

  const openQuotes = allQuotes.filter(
    (q) => q.status === "draft" || q.status === "sent" || q.status === "viewed",
  );
  const acceptedQuotes = allQuotes.filter((q) => q.status === "accepted");
  const outstandingInvoices = invoices.filter(
    (inv) => inv.status === "sent" || inv.status === "overdue",
  );
  const outstandingTotal = outstandingInvoices.reduce(
    (s, inv) => s + Number(inv.total ?? 0),
    0,
  );
  const recentQuote = allQuotes[0];
  const recentInvoice = invoices[0];

  // Action centre — precise, financially-labelled things that need this
  // customer's attention, deep-linking to the existing single-authority
  // surfaces (/q/<token> for quote decisions; the invoice tab otherwise).
  // Report decisions are surfaced in the document-library slice, which already
  // reads report content — kept out here to avoid an N+1 on the overview.
  const today = new Date().toISOString().slice(0, 10);
  const actionItems = buildPortalActionItems({
    token,
    todayIso: today,
    quotes: allQuotes,
    invoices,
    reports: [],
  });

  return (
    <PortalShell customer={customer} org={org} token={token} active="overview">
      {actionItems.length > 0 ? (
        <section aria-labelledby="action-centre" className="rounded-xl border border-slate-900/10 bg-white p-4 shadow-sm ring-1 ring-slate-900/5">
          <h2 id="action-centre" className="text-sm font-semibold text-slate-900">
            Needs your attention
          </h2>
          <ul className="mt-3 space-y-2">
            {actionItems.map((item, i) => (
              <ActionRow key={`${item.kind}-${i}`} item={item} />
            ))}
          </ul>
        </section>
      ) : null}

      {/* Headline KPIs — mobile-stack-then-row */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard label="Open quotes" value={openQuotes.length.toString()} />
        <SummaryCard label="Accepted quotes" value={acceptedQuotes.length.toString()} />
        <SummaryCard
          label="Outstanding"
          value={GBP.format(outstandingTotal)}
          sub={`${outstandingInvoices.length} ${outstandingInvoices.length === 1 ? "invoice" : "invoices"}`}
        />
      </section>

      {/* Most recent quote */}
      {recentQuote ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Most recent quote
              </div>
              <Link
                href={`/q/${recentQuote.public_token}`}
                className="mt-1 block text-base font-semibold text-slate-900 hover:text-slate-700"
              >
                {recentQuote.number}
              </Link>
            </div>
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${QUOTE_STATUS_STYLES[recentQuote.status] ?? "bg-slate-100 text-slate-700"}`}
            >
              {recentQuote.status}
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between text-sm">
            <span className="text-slate-600">
              {recentQuote.valid_until
                ? `Valid until ${recentQuote.valid_until}`
                : "—"}
            </span>
            <span className="font-medium text-slate-900">
              {GBP.format(Number(recentQuote.total ?? 0))}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href={`/q/${recentQuote.public_token}`}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-slate-800"
            >
              View &amp; respond
            </Link>
            <a
              href={`/q/${recentQuote.public_token}/pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Download PDF
            </a>
            <Link
              href={`/customer-portal/${token}/quotes`}
              className="self-center text-xs font-medium text-slate-500 hover:text-slate-900"
            >
              All quotes →
            </Link>
          </div>
        </section>
      ) : null}

      {/* Most recent invoice */}
      {recentInvoice ? (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Most recent invoice
              </div>
              <div className="mt-1 text-base font-semibold text-slate-900">
                {recentInvoice.number}
              </div>
            </div>
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${INVOICE_STATUS_STYLES[recentInvoice.status] ?? "bg-slate-100 text-slate-700"}`}
            >
              {recentInvoice.status}
            </span>
          </div>
          <div className="mt-2 flex items-center justify-between text-sm">
            <span className="text-slate-600">
              {recentInvoice.due_date
                ? `Due ${recentInvoice.due_date}`
                : "—"}
            </span>
            <span className="font-medium text-slate-900">
              {GBP.format(Number(recentInvoice.total ?? 0))}
            </span>
          </div>
          <div className="mt-3">
            <Link
              href={`/customer-portal/${token}/invoices`}
              className="text-xs font-medium text-slate-500 hover:text-slate-900"
            >
              All invoices →
            </Link>
          </div>
        </section>
      ) : null}

      {/* Empty state */}
      {!recentQuote && !recentInvoice ? (
        <section className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-slate-900">Nothing here yet</p>
          <p className="mt-1 text-xs text-slate-500">
            When {org.name} sends you quotes or invoices, they&apos;ll appear
            on this page.
          </p>
        </section>
      ) : null}
    </PortalShell>
  );
}

const ACTION_ACCENT: Record<PortalActionItem["kind"], string> = {
  invoice_overdue: "border-l-red-500",
  quote: "border-l-blue-500",
  invoice_due: "border-l-amber-500",
  report_decision: "border-l-slate-400",
};

function ActionRow({ item }: { item: PortalActionItem }) {
  const external = item.href.startsWith("/q/");
  return (
    <li className={`rounded-md border border-slate-200 border-l-4 ${ACTION_ACCENT[item.kind]} bg-white p-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">{item.label}</p>
          <p className="mt-0.5 text-xs text-slate-500">{item.sub}</p>
        </div>
        <Link
          href={item.href}
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="shrink-0 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
        >
          {item.kind === "quote"
            ? "Review"
            : item.kind === "report_decision"
              ? "Open report"
              : "View invoice"}
        </Link>
      </div>
    </li>
  );
}

function SummaryCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-1 text-xl font-bold text-slate-900">{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-slate-500">{sub}</div> : null}
    </div>
  );
}
