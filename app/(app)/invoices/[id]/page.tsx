import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { InvoiceControls } from "./_controls";
import type { InvoiceStatus } from "@/lib/invoices/schema";

/**
 * Invoice detail view.
 *
 * Shows invoice header, the linked quote's line items, totals, audit
 * timestamps, and the status-update / delete controls.
 *
 * PDF generation deferred per spec.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

const STATUS_STYLES: Record<InvoiceStatus, string> = {
  draft: "bg-slate-100 text-slate-700",
  sent: "bg-blue-100 text-blue-700",
  paid: "bg-green-100 text-green-700",
  overdue: "bg-red-100 text-red-700",
};

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireOrgContext();
  const supabase = await createClient();

  const { data: invoice } = await supabase
    .from("invoices")
    .select(
      "id, number, status, amount, vat_total, total, due_date, sent_at, paid_at, notes, created_at, quote_id",
    )
    .eq("id", id)
    .maybeSingle();

  if (!invoice) notFound();

  // Line items from the source quote (if still present).
  const lineItems = invoice.quote_id
    ? (
        await supabase
          .from("quote_line_items")
          .select("id, description, qty, unit, unit_price, vat_rate, line_total, sort_order")
          .eq("quote_id", invoice.quote_id)
          .order("sort_order", { ascending: true })
      ).data ?? []
    : [];

  const status = invoice.status as InvoiceStatus;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Link href="/invoices" className="hover:text-slate-900">
          Invoices
        </Link>
        <span aria-hidden>/</span>
        <span className="text-slate-900">{invoice.number}</span>
      </div>

      <header className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{invoice.number}</h1>
          <p className="mt-1 text-sm text-slate-600">
            Created {invoice.created_at.slice(0, 10)}
            {invoice.due_date ? ` · Due ${invoice.due_date}` : ""}
          </p>
        </div>
        <span
          className={`inline-flex rounded-full px-3 py-1 text-xs font-medium ${STATUS_STYLES[status]}`}
        >
          {status}
        </span>
      </header>

      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Net
          </div>
          <div className="mt-1 text-lg font-semibold text-slate-900">
            {GBP.format(Number(invoice.amount ?? 0))}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
            VAT
          </div>
          <div className="mt-1 text-lg font-semibold text-slate-900">
            {GBP.format(Number(invoice.vat_total ?? 0))}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Total
          </div>
          <div className="mt-1 text-lg font-semibold text-slate-900">
            {GBP.format(Number(invoice.total ?? 0))}
          </div>
        </div>
      </section>

      {lineItems.length > 0 ? (
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <header className="border-b border-slate-200 px-6 py-3">
            <h2 className="text-base font-semibold text-slate-900">Line items</h2>
            <p className="text-xs text-slate-500">From quote {invoice.quote_id?.slice(0, 8)}</p>
          </header>
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-6 py-2">Description</th>
                <th className="px-6 py-2 text-right">Qty</th>
                <th className="px-6 py-2 text-right">Unit</th>
                <th className="px-6 py-2 text-right">VAT %</th>
                <th className="px-6 py-2 text-right">Line total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {lineItems.map((li) => (
                <tr key={li.id}>
                  <td className="px-6 py-2 text-slate-900">{li.description}</td>
                  <td className="px-6 py-2 text-right text-slate-600">{Number(li.qty)}</td>
                  <td className="px-6 py-2 text-right text-slate-600">
                    {GBP.format(Number(li.unit_price ?? 0))}
                  </td>
                  <td className="px-6 py-2 text-right text-slate-600">
                    {Number(li.vat_rate)}%
                  </td>
                  <td className="px-6 py-2 text-right font-medium text-slate-900">
                    {GBP.format(Number(li.line_total ?? 0))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : (
        <p className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
          No line items — the source quote may have been deleted, or the quote
          has no line items.
        </p>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Audit</h2>
        <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Sent at</dt>
            <dd className="text-slate-700">{invoice.sent_at ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-slate-500">Paid at</dt>
            <dd className="text-slate-700">{invoice.paid_at ?? "—"}</dd>
          </div>
        </dl>
        {invoice.notes ? (
          <div className="mt-4">
            <div className="text-xs uppercase tracking-wide text-slate-500">Notes</div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">
              {invoice.notes}
            </p>
          </div>
        ) : null}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Actions</h2>
        <div className="mt-3">
          <InvoiceControls id={invoice.id} status={status} />
        </div>
      </section>
    </div>
  );
}
