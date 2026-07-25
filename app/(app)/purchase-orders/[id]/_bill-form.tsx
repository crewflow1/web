"use client";

import { useActionState } from "react";
import { INITIAL_FORM_STATE } from "@/lib/forms/state";
import { recordSupplierBill } from "../actions";

/**
 * Record-a-supplier-bill form (Financial Operations). Wires the existing
 * `recordSupplierBill` action — the bill posts to `finances` against this PO,
 * inheriting its job + supplier, closing committed → actual. Same useActionState
 * idiom + house form styling as the rest of the PO surface.
 */
export function RecordBillForm({ poId }: { poId: string }) {
  const [state, action, pending] = useActionState(
    recordSupplierBill.bind(null, poId),
    INITIAL_FORM_STATE,
  );

  return (
    <form action={action} className="mt-5 space-y-3 border-t border-slate-100 pt-4">
      <p className="text-sm font-medium text-slate-900">Record a bill</p>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">
          <span className="text-slate-600">Amount (ex-VAT) £</span>
          <input
            name="amount"
            type="text"
            inputMode="decimal"
            required
            placeholder="0.00"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
          />
        </label>
        <label className="text-sm">
          <span className="text-slate-600">VAT</span>
          <select
            name="vat_rate"
            defaultValue="20"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
          >
            <option value="0">0%</option>
            <option value="5">5%</option>
            <option value="20">20%</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="text-slate-600">
            Supplier invoice no. <span className="text-slate-400">optional</span>
          </span>
          <input
            name="reference"
            type="text"
            placeholder="e.g. WES-88421"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
          />
        </label>
        <label className="text-sm">
          <span className="text-slate-600">
            Bill date <span className="text-slate-400">optional</span>
          </span>
          <input
            name="bill_date"
            type="date"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
          />
        </label>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-red-600">
          {state.error}
        </p>
      ) : null}
      {state.ok && state.successMessage ? (
        <p role="status" className="text-sm text-emerald-600">
          {state.successMessage}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
      >
        {pending ? "Recording…" : "Record bill"}
      </button>
    </form>
  );
}
