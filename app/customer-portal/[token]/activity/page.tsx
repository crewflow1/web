import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { loadCustomerByPortalToken } from "../../_helpers";
import { listPortalReports } from "../../_reports";
import { PortalShell } from "../_shell";
import { InvalidLinkPage } from "@/app/_components/invalid-link";
import {
  buildPortalTimeline,
  type PortalTimelineEvent,
} from "@/lib/customers/portal-timeline";

/**
 * Customer portal — unified activity timeline.
 *
 * One reverse-chronological feed of this customer's relationship: quotes sent /
 * accepted, invoices issued, payments received, reports published. Every read is
 * scoped by BOTH org_id AND the token-resolved customer (quotes/invoices by
 * customer_id; payments by this customer's own invoice ids; reports through the
 * single portal reports authority), so a crafted URL can surface nothing but the
 * customer's own history. The weaving/labelling is the pure, customer-safe
 * buildPortalTimeline — it has no field for internal notes, staff or cost basis.
 */

const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const ACCENT: Record<PortalTimelineEvent["kind"], string> = {
  quote_sent: "bg-blue-500",
  quote_accepted: "bg-green-500",
  invoice_issued: "bg-indigo-500",
  payment_received: "bg-emerald-500",
  report_published: "bg-slate-500",
};

export default async function PortalActivityPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) return <InvalidLinkPage kind="portal" />;
  const { customer, org } = loaded;

  const admin = createAdminClient();

  type QuoteRow = {
    id: string;
    number: string | null;
    status: string;
    total: number | string | null;
    sent_at: string | null;
    accepted_at: string | null;
    public_token: string | null;
  };
  const { data: quotes, error: quotesErr } = await fetchAllRows<QuoteRow>(
    (from, to) =>
      admin
        .from("quotes")
        .select("id, number, status, total, sent_at, accepted_at, public_token")
        .eq("org_id", customer.org_id)
        .eq("customer_id", customer.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: QuoteRow[] | null;
        error: unknown;
      }>,
  );
  if (quotesErr) throw readFailure("portal activity: quotes", quotesErr);

  type InvoiceRow = {
    id: string;
    number: string | null;
    total: number | string | null;
    sent_at: string | null;
  };
  const { data: invoices, error: invoicesErr } = await fetchAllRows<InvoiceRow>(
    (from, to) =>
      admin
        .from("invoices")
        .select("id, number, total, sent_at")
        .eq("org_id", customer.org_id)
        .eq("customer_id", customer.id)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{
        data: InvoiceRow[] | null;
        error: unknown;
      }>,
  );
  if (invoicesErr) throw readFailure("portal activity: invoices", invoicesErr);

  // Payments — scoped to THIS customer's own invoice ids. No customer's payment
  // can appear without one of their invoices anchoring it.
  type PaymentRow = { id: string; amount: number | string | null; paid_at: string | null };
  let payments: PaymentRow[] = [];
  if (invoices.length > 0) {
    const ids = invoices.map((i) => i.id);
    const { data, error } = await fetchAllRows<PaymentRow>(
      (from, to) =>
        admin
          .from("invoice_payments")
          .select("id, amount, paid_at")
          .in("invoice_id", ids)
          .order("paid_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<{
          data: PaymentRow[] | null;
          error: unknown;
        }>,
    );
    if (error) throw readFailure("portal activity: payments", error);
    payments = data;
  }

  const reports = await listPortalReports(customer.id, customer.org_id);

  const events = buildPortalTimeline({
    token,
    quotes,
    invoices,
    payments: payments.map((p) => ({ id: p.id, amount: p.amount, at: p.paid_at })),
    reports: reports.map((r) => ({
      id: r.id,
      title: r.title,
      report_number: r.report_number,
      portal_published_at: r.portal_published_at,
    })),
  });

  return (
    <PortalShell customer={customer} org={org} token={token} active="activity">
      <section aria-labelledby="activity-heading" className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
        <h2 id="activity-heading" className="text-base font-semibold text-slate-900">
          Activity
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          Everything that&apos;s happened on your account with {org.name}, newest first.
        </p>

        {events.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed border-slate-300 p-8 text-center">
            <p className="text-sm font-medium text-slate-900">Nothing here yet</p>
            <p className="mt-1 text-xs text-slate-500">
              As quotes, invoices, payments and reports come through, they&apos;ll
              appear on this timeline.
            </p>
          </div>
        ) : (
          <ol className="mt-5 space-y-4">
            {events.map((e, i) => (
              <li key={`${e.kind}-${i}`} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <span
                    aria-hidden="true"
                    className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${ACCENT[e.kind]}`}
                  />
                  {i < events.length - 1 ? (
                    <span aria-hidden="true" className="mt-1 w-px flex-1 bg-slate-200" />
                  ) : null}
                </div>
                <div className="min-w-0 pb-1">
                  <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
                    {DATE.format(new Date(e.at))}
                  </div>
                  <Link
                    href={e.href}
                    {...(e.href.startsWith("/q/")
                      ? { target: "_blank", rel: "noopener noreferrer" }
                      : {})}
                    className="mt-0.5 block text-sm font-semibold text-slate-900 hover:text-slate-700"
                  >
                    {e.title}
                  </Link>
                  <p className="mt-0.5 text-xs text-slate-500">{e.sub}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </PortalShell>
  );
}
