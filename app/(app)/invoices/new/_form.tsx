"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * New-invoice form: pick a quote, set due_date, submit.
 *
 * Posts JSON to POST /api/invoices. On success, redirects to the new
 * invoice detail page.
 */

type QuoteOption = {
  id: string;
  number: string | null;
  subtotal: number;
  total: number;
  status: string;
};

export function NewInvoiceForm({ quotes }: { quotes: QuoteOption[] }) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const fd = new FormData(e.currentTarget);
    const payload = {
      quote_id: String(fd.get("quote_id") ?? ""),
      due_date: String(fd.get("due_date") ?? ""),
      notes: String(fd.get("notes") ?? ""),
    };
    try {
      const res = await fetch("/api/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `Request failed (${res.status})`);
        setSubmitting(false);
        return;
      }
      const j = (await res.json()) as { id: string };
      router.push(`/invoices/${j.id}`);
      router.refresh();
    } catch {
      setError("Network error. Try again.");
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      ) : null}

      <div>
        <label htmlFor="quote_id" className="block text-sm font-medium text-slate-800">
          Source quote <span className="text-red-500">*</span>
        </label>
        <select
          id="quote_id"
          name="quote_id"
          required
          defaultValue=""
          className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        >
          <option value="" disabled>
            {quotes.length === 0 ? "— No quotes yet —" : "Select a quote…"}
          </option>
          {quotes.map((q) => (
            <option key={q.id} value={q.id}>
              {q.number ?? q.id.slice(0, 8)} · £{q.total.toFixed(2)} · {q.status}
            </option>
          ))}
        </select>
        <p className="mt-1 text-xs text-slate-500">
          Amount and VAT are copied from the quote.
        </p>
      </div>

      <div>
        <label htmlFor="due_date" className="block text-sm font-medium text-slate-800">
          Due date <span className="text-xs text-slate-400">Optional</span>
        </label>
        <input
          id="due_date"
          name="due_date"
          type="date"
          className="mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </div>

      <div>
        <label htmlFor="notes" className="block text-sm font-medium text-slate-800">
          Notes <span className="text-xs text-slate-400">Optional</span>
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={3}
          className="mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={submitting || quotes.length === 0}
          className="rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-50"
        >
          {submitting ? "Generating…" : "Generate invoice"}
        </button>
        <Link
          href="/invoices"
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
