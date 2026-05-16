"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { computeTotals } from "@/lib/quotes/totals";
import { QUOTE_VAT_RATES, type LineItem } from "@/lib/quotes/schema";

/**
 * Quote builder — used by both /quotes/new and /quotes/[id].
 *
 * Client component: holds the working line-items list in local state and
 * computes totals live as the user types. On submit, serialises the
 * line items as JSON in a hidden field and posts to the server action
 * supplied via `action` prop.
 *
 * Property dropdown is optional and filters to the selected customer
 * via a useMemo over the prefetched list (no extra fetch round-trip).
 */

type CustomerOption = { id: string; name: string };
type PropertyOption = { id: string; label: string; customer_id: string | null };
type LeadOption = { id: string; label: string; customer_id: string | null };

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

const emptyLine: LineItem = {
  description: "",
  qty: 1,
  unit: "ea",
  unit_price: 0,
  vat_rate: 20,
};

export function QuoteBuilder({
  action,
  submitLabel,
  customers,
  properties,
  leads,
  defaultCustomerId = "",
  defaultPropertyId = "",
  defaultLeadId = "",
  defaultValidUntil = "",
  defaultNotes = "",
  defaultTerms = "",
  defaultLineItems,
  errorMessage,
  savedMessage,
  cancelHref = "/quotes",
}: {
  action: (formData: FormData) => void;
  submitLabel: string;
  customers: CustomerOption[];
  properties: PropertyOption[];
  leads: LeadOption[];
  defaultCustomerId?: string;
  defaultPropertyId?: string;
  defaultLeadId?: string;
  defaultValidUntil?: string;
  defaultNotes?: string;
  defaultTerms?: string;
  defaultLineItems?: LineItem[];
  errorMessage?: string | null;
  savedMessage?: string | null;
  cancelHref?: string;
}) {
  const [customerId, setCustomerId] = useState(defaultCustomerId);
  const [items, setItems] = useState<LineItem[]>(
    defaultLineItems && defaultLineItems.length > 0
      ? defaultLineItems
      : [{ ...emptyLine }],
  );

  const propertyOptions = useMemo(() => {
    // If no customer selected, show all; else filter to that customer.
    if (!customerId) return properties;
    return properties.filter(
      (p) => !p.customer_id || p.customer_id === customerId,
    );
  }, [properties, customerId]);

  const leadOptions = useMemo(() => {
    if (!customerId) return leads;
    return leads.filter(
      (l) => !l.customer_id || l.customer_id === customerId,
    );
  }, [leads, customerId]);

  const totals = useMemo(() => computeTotals(items), [items]);

  function updateLine(idx: number, patch: Partial<LineItem>) {
    setItems((prev) => prev.map((li, i) => (i === idx ? { ...li, ...patch } : li)));
  }
  function addLine() {
    setItems((prev) => [...prev, { ...emptyLine }]);
  }
  function removeLine(idx: number) {
    setItems((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  }

  return (
    <form action={action} className="space-y-6">
      {errorMessage ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {errorMessage}
        </div>
      ) : null}
      {savedMessage ? (
        <div
          role="status"
          className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700"
        >
          {savedMessage}
        </div>
      ) : null}

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Customer + site</h2>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-slate-800">
              Customer <span className="text-red-500">*</span>
            </label>
            <select
              name="customer_id"
              required
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            >
              <option value="" disabled>
                {customers.length === 0 ? "— No customers yet —" : "Select a customer…"}
              </option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-800">
              Site / property <span className="text-xs text-slate-400">Optional</span>
            </label>
            <select
              name="property_id"
              defaultValue={defaultPropertyId}
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            >
              <option value="">— None —</option>
              {propertyOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium text-slate-800">
              Linked lead <span className="text-xs text-slate-400">Optional</span>
            </label>
            <select
              name="lead_id"
              defaultValue={defaultLeadId}
              className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            >
              <option value="">— None —</option>
              {leadOptions.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-800">
              Valid until <span className="text-xs text-slate-400">Optional</span>
            </label>
            <input
              type="date"
              name="valid_until"
              defaultValue={defaultValidUntil}
              className="mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">Line items</h2>
          <button
            type="button"
            onClick={addLine}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            + Add line
          </button>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-left text-xs font-semibold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-2 py-2">Description</th>
                <th className="w-20 px-2 py-2 text-right">Qty</th>
                <th className="w-24 px-2 py-2 text-right">Unit £</th>
                <th className="w-20 px-2 py-2 text-right">VAT %</th>
                <th className="w-28 px-2 py-2 text-right">Line £</th>
                <th className="w-8 px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((li, idx) => (
                <tr key={idx} className="align-top">
                  <td className="px-2 py-2">
                    <input
                      type="text"
                      required
                      value={li.description}
                      onChange={(e) =>
                        updateLine(idx, { description: e.target.value })
                      }
                      placeholder="e.g. Slate tiles — supply only"
                      className="block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      required
                      value={li.qty}
                      onChange={(e) =>
                        updateLine(idx, { qty: Number(e.target.value) || 0 })
                      }
                      className="block w-20 rounded-md border border-slate-300 px-2 py-1.5 text-right text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      required
                      value={li.unit_price}
                      onChange={(e) =>
                        updateLine(idx, { unit_price: Number(e.target.value) || 0 })
                      }
                      className="block w-24 rounded-md border border-slate-300 px-2 py-1.5 text-right text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                    />
                  </td>
                  <td className="px-2 py-2 text-right">
                    <select
                      value={li.vat_rate}
                      onChange={(e) =>
                        updateLine(idx, { vat_rate: Number(e.target.value) })
                      }
                      className="block w-20 rounded-md border border-slate-300 px-2 py-1.5 text-right text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                    >
                      {QUOTE_VAT_RATES.map((r) => (
                        <option key={r} value={r}>
                          {r}%
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2 text-right text-sm font-medium text-slate-900">
                    {GBP.format(totals.lines[idx]?.line_total ?? 0)}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => removeLine(idx)}
                      disabled={items.length <= 1}
                      aria-label="Remove line"
                      className="rounded-md px-1.5 py-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-red-600 disabled:opacity-40"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <dl className="mt-4 ml-auto max-w-xs space-y-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-slate-600">Subtotal</dt>
            <dd className="font-medium text-slate-900">{GBP.format(totals.subtotal)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-600">VAT</dt>
            <dd className="font-medium text-slate-900">{GBP.format(totals.vat_total)}</dd>
          </div>
          <div className="flex justify-between border-t border-slate-200 pt-1">
            <dt className="font-medium text-slate-900">Total</dt>
            <dd className="font-bold text-slate-900">{GBP.format(totals.total)}</dd>
          </div>
        </dl>

        {/* Hidden field carries the structured line items to the server action. */}
        <input
          type="hidden"
          name="line_items"
          value={JSON.stringify(items)}
        />
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">Notes + terms</h2>
        <div className="mt-4 grid grid-cols-1 gap-4">
          <div>
            <label className="block text-sm font-medium text-slate-800">
              Notes <span className="text-xs text-slate-400">Visible on the customer PDF</span>
            </label>
            <textarea
              name="notes"
              rows={3}
              defaultValue={defaultNotes}
              className="mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              placeholder="e.g. Includes scaffolding hire and disposal of old roofing."
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-800">
              Terms &amp; conditions
            </label>
            <textarea
              name="terms"
              rows={5}
              defaultValue={defaultTerms}
              className="mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              placeholder="Standard payment terms, warranty, etc."
            />
          </div>
        </div>
      </section>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800"
        >
          {submitLabel}
        </button>
        <Link
          href={cancelHref}
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
