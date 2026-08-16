"use client";

import { useState } from "react";

/**
 * Statement-of-account panel — shared date range driving two actions:
 *   - Download PDF: a GET form to /api/customers/[id]/statement/pdf (opens in a
 *     new tab; the browser renders the inline PDF). No JS round-trip.
 *   - Email to customer: a POST to the `sendCustomerStatement` server action,
 *     with the same range mirrored into hidden inputs.
 *
 * Client-side only so the two forms share one set of date inputs; the actual
 * work is entirely server-side (the action + the API route).
 */
export function StatementPanel({
  pdfHref,
  sendAction,
  customerEmail,
}: {
  pdfHref: string;
  sendAction: (formData: FormData) => void;
  customerEmail: string | null;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(today);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 className="text-base font-semibold text-slate-900">Statement of account</h2>
      <p className="mt-1 text-sm text-slate-600">
        A running ledger of every invoice and payment with the balance owed. Leave the start date
        blank to include all activity from the beginning of the account.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">From (optional)</span>
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-600">To</span>
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none"
          />
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {/* Download: GET form → PDF route, opens in a new tab. */}
        <form action={pdfHref} method="get" target="_blank" rel="noopener">
          {from ? <input type="hidden" name="from" value={from} /> : null}
          {to ? <input type="hidden" name="to" value={to} /> : null}
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-slate-800"
          >
            Download PDF
          </button>
        </form>

        {/* Email: POST → server action, same range via hidden inputs. */}
        <form action={sendAction}>
          <input type="hidden" name="from" value={from} />
          <input type="hidden" name="to" value={to} />
          <button
            type="submit"
            disabled={!customerEmail}
            title={customerEmail ? undefined : "Add an email to this customer to send their statement"}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Email to customer
          </button>
        </form>
      </div>

      {customerEmail ? (
        <p className="mt-2 text-xs text-slate-500">Sends to {customerEmail}.</p>
      ) : (
        <p className="mt-2 text-xs text-slate-500">
          This customer has no email on file — add one above to email their statement.
        </p>
      )}
    </section>
  );
}
