import { addInvoicePayment, removeInvoicePayment } from "./payment-actions";

/**
 * Server component (no client interactivity needed — form posts use
 * the server actions directly). Renders:
 *   - Money tile: total / paid / outstanding
 *   - Existing payments list with remove buttons
 *   - Add-payment form (only when outstanding > 0)
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

type Payment = {
  id: string;
  amount: number;
  paid_at: string;
  reference: string | null;
  notes: string | null;
  source: "manual" | "bank_csv";
};

export function PaymentsPanel({
  invoiceId,
  invoiceTotal,
  paidTotal,
  outstanding,
  payments,
}: {
  invoiceId: string;
  invoiceTotal: number;
  paidTotal: number;
  outstanding: number;
  payments: Payment[];
}) {
  const todayIso = new Date().toISOString().slice(0, 10);
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">Payments</h2>

      <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Invoice total</dt>
          <dd className="mt-0.5 text-lg font-semibold text-slate-900">
            {GBP.format(invoiceTotal)}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Paid</dt>
          <dd className="mt-0.5 text-lg font-semibold text-green-700">
            {GBP.format(paidTotal)}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-slate-500">Outstanding</dt>
          <dd
            className={`mt-0.5 text-lg font-semibold ${outstanding === 0 ? "text-slate-400" : "text-slate-900"}`}
          >
            {GBP.format(outstanding)}
          </dd>
        </div>
      </dl>

      {/* History */}
      {payments.length > 0 ? (
        <div className="mt-5">
          <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
            History
          </div>
          <ul className="mt-2 divide-y divide-slate-100">
            {payments.map((p) => (
              <li key={p.id} className="flex items-center gap-3 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-slate-900">
                    {GBP.format(p.amount)}
                    <span className="ml-2 text-xs font-normal text-slate-500">
                      {p.paid_at}
                      {p.source === "bank_csv" ? " · from bank CSV" : ""}
                    </span>
                  </div>
                  {p.reference ? (
                    <div className="text-xs text-slate-500">ref: {p.reference}</div>
                  ) : null}
                  {p.notes ? (
                    <div className="text-xs text-slate-500 line-clamp-2">{p.notes}</div>
                  ) : null}
                </div>
                <form action={removeInvoicePayment.bind(null, p.id)}>
                  <button
                    type="submit"
                    className="rounded-md border border-red-300 bg-white px-2 py-0.5 text-xs font-medium text-red-700 hover:bg-red-50"
                    title="Remove this payment (status will be recomputed)"
                  >
                    Remove
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Add form */}
      {outstanding > 0 ? (
        <form
          action={addInvoicePayment.bind(null, invoiceId)}
          className="mt-5 grid grid-cols-1 gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 sm:grid-cols-5"
        >
          <label className="block text-xs text-slate-600">
            Amount (£)
            <input
              type="number"
              name="amount"
              required
              min={0.01}
              step={0.01}
              defaultValue={outstanding.toFixed(2)}
              className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block text-xs text-slate-600">
            Paid on
            <input
              type="date"
              name="paid_at"
              required
              defaultValue={todayIso}
              className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block text-xs text-slate-600 sm:col-span-1">
            Reference
            <input
              type="text"
              name="reference"
              placeholder="bank ref / cheque #"
              className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="block text-xs text-slate-600 sm:col-span-2">
            Notes
            <input
              type="text"
              name="notes"
              placeholder="e.g. transferred via Faster Payments"
              className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
          </label>
          <div className="sm:col-span-5">
            <button
              type="submit"
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800"
            >
              Record payment
            </button>
            <p className="mt-1 text-[11px] text-slate-500">
              Status auto-updates: any amount &gt; 0 → partially_paid; total
              fully paid → paid. Adding multiple smaller payments is fine.
            </p>
          </div>
        </form>
      ) : (
        <p className="mt-5 rounded-md border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          Paid in full. Add or remove payments above if anything changes.
        </p>
      )}
    </section>
  );
}
