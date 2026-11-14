import type { BillingHistory } from "@/server/services/billing-history";

/**
 * Invoices & receipts — the org's CrewFlow billing history.
 *
 * A server component (no client boundary). Shown on Settings → Billing and on
 * /account/billing, so it renders the same whether the subscription is active,
 * suspended or cancelled. When the history comes from Stripe each row links to
 * the Stripe-hosted invoice page and PDF; when it comes from CrewFlow's own
 * records there is no link and the footer says how to get a copy.
 */

const STATUS_LABEL: Record<string, string> = {
  paid: "Paid",
  open: "Unpaid",
  sent: "Unpaid",
  failed: "Payment failed",
  uncollectible: "Unpaid",
  void: "Void",
  refunded: "Refunded",
};

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export function InvoiceHistory({ history }: { history: BillingHistory }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">Invoices &amp; receipts</h2>
      {history.invoices.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600">No invoices yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-slate-100">
          {history.invoices.map((inv) => (
            <li
              key={inv.id}
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5 text-sm"
            >
              <div className="min-w-0">
                <div className="font-medium text-slate-900">
                  {inv.number ?? (inv.date ? `Invoice of ${inv.date.slice(0, 10)}` : "Invoice")}
                </div>
                <div className="text-xs text-slate-600">
                  {inv.date ? inv.date.slice(0, 10) : ""}
                  {inv.status ? ` · ${STATUS_LABEL[inv.status] ?? inv.status}` : ""}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-semibold tabular-nums text-slate-900">
                  {money(inv.amount, inv.currency)}
                </span>
                {inv.hostedUrl ? (
                  <a
                    href={inv.hostedUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-medium text-slate-900 underline"
                  >
                    View<span className="sr-only"> invoice {inv.number ?? inv.id}</span>
                  </a>
                ) : null}
                {inv.pdfUrl ? (
                  <a
                    href={inv.pdfUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs font-medium text-slate-900 underline"
                  >
                    PDF<span className="sr-only"> of invoice {inv.number ?? inv.id}</span>
                  </a>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {history.source === "records" ? (
        <p className="mt-3 text-xs text-slate-600">
          {history.degraded
            ? "We couldn't load invoice documents from our payment provider just now, so this shows our own records. "
            : ""}
          Need a copy of an invoice or receipt? Email{" "}
          <a href="mailto:hello@crewflow.uk" className="underline">
            hello@crewflow.uk
          </a>
          .
        </p>
      ) : null}
    </section>
  );
}
