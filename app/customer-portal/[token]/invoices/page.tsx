import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "../../_helpers";
import { PortalShell } from "../_shell";

/**
 * Customer-side invoices list.
 *
 * Read-only — no pay button yet (Slice 4C Payments). Customers see:
 * invoice number, status, amount, due date. Invoices for this
 * customer = invoices whose quote_id is one of the customer's quotes.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  sent: "bg-blue-100 text-blue-700",
  awaiting_payment: "bg-amber-100 text-amber-800",
  partially_paid: "bg-indigo-100 text-indigo-800",
  paid: "bg-green-100 text-green-700",
  overdue: "bg-red-100 text-red-700",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "draft",
  sent: "sent",
  awaiting_payment: "awaiting payment",
  partially_paid: "partially paid",
  paid: "paid",
  overdue: "overdue",
};

export default async function PortalInvoicesPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) notFound();
  const { customer, org } = loaded;

  const admin = createAdminClient();

  // Get this customer's quote IDs first, then invoices linked to them.
  const { data: customerQuotes } = await admin
    .from("quotes")
    .select("id")
    .eq("org_id", customer.org_id)
    .eq("customer_id", customer.id);
  const quoteIds = (customerQuotes ?? []).map((q) => q.id);

  let invoices: Array<{
    id: string;
    number: string;
    status: string;
    amount: number | string | null;
    vat_total: number | string | null;
    total: number | string | null;
    due_date: string | null;
    sent_at: string | null;
    paid_at: string | null;
    created_at: string;
  }> = [];

  if (quoteIds.length > 0) {
    const { data } = await admin
      .from("invoices")
      .select(
        "id, number, status, amount, vat_total, total, due_date, sent_at, paid_at, created_at",
      )
      .eq("org_id", customer.org_id)
      .in("quote_id", quoteIds)
      .order("created_at", { ascending: false })
      .limit(200);
    invoices = data ?? [];
  }

  // Paid-so-far per invoice for the partial-payment display.
  const paidByInvoice = new Map<string, number>();
  if (invoices.length > 0) {
    const ids = invoices.map((i) => i.id);
    const { data: payments } = await admin
      .from("invoice_payments")
      .select("invoice_id, amount")
      .in("invoice_id", ids);
    for (const p of payments ?? []) {
      const prev = paidByInvoice.get(p.invoice_id) ?? 0;
      paidByInvoice.set(p.invoice_id, prev + Number(p.amount ?? 0));
    }
  }

  return (
    <PortalShell customer={customer} org={org} token={token} active="invoices">
      {invoices.length === 0 ? (
        <section className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center">
          <p className="text-sm font-medium text-slate-900">No invoices yet</p>
          <p className="mt-1 text-xs text-slate-500">
            Once you accept a quote from {org.name}, an invoice will appear
            here.
          </p>
        </section>
      ) : (
        <ol className="space-y-3">
          {invoices.map((inv) => {
            const total = Number(inv.total ?? 0);
            const paid = paidByInvoice.get(inv.id) ?? 0;
            const outstanding = Math.max(0, total - paid);
            const isFullyPaid = inv.status === "paid" || outstanding === 0;
            return (
              <li
                key={inv.id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-base font-semibold text-slate-900">
                      {inv.number}
                    </div>
                    <p className="mt-1 text-xs text-slate-500">
                      {inv.sent_at ? `Sent ${inv.sent_at.slice(0, 10)}` : "Draft"}
                      {inv.due_date ? ` · Due ${inv.due_date}` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[inv.status] ?? "bg-slate-100 text-slate-700"}`}
                    >
                      {STATUS_LABELS[inv.status] ?? inv.status}
                    </span>
                    <div className="mt-1 text-sm font-semibold text-slate-900">
                      {GBP.format(total)}
                    </div>
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-3 text-xs text-slate-600">
                  <div>
                    <dt className="text-slate-500">Paid so far</dt>
                    <dd className="font-medium text-green-700">
                      {GBP.format(paid)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Outstanding</dt>
                    <dd
                      className={
                        outstanding === 0
                          ? "text-slate-400"
                          : "font-medium text-slate-900"
                      }
                    >
                      {GBP.format(outstanding)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Paid at</dt>
                    <dd className="text-slate-900">
                      {inv.paid_at ? inv.paid_at.slice(0, 10) : "—"}
                    </dd>
                  </div>
                </dl>
                {isFullyPaid ? (
                  <p className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
                    Paid in full — thank you.
                  </p>
                ) : inv.status === "partially_paid" ? (
                  <p className="mt-3 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-800">
                    {org.name} has recorded {GBP.format(paid)} so far against
                    this invoice. {GBP.format(outstanding)} remains
                    outstanding. Use the bank details on the invoice PDF for
                    the balance.
                  </p>
                ) : (
                  <p className="mt-3 text-xs text-slate-500">
                    {org.name} accepts payment by bank transfer — bank
                    details + payment reference are on the invoice PDF.
                    Payments are matched manually, so allow 1–2 working days
                    for the status to update.
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </PortalShell>
  );
}
