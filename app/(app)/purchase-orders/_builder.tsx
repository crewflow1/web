"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { computeTotals } from "@/lib/quotes/totals";
import { withPreservedOption } from "@/lib/quotes/preserve-option";
import { PO_VAT_RATES, type PurchaseOrderFormInput } from "@/lib/purchase-orders/schema";

type Option = { id: string; name: string };
type Row = { description: string; qty: string; unit: string; unit_price: string; vat_rate: string };

const GBP = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2 });

const blankRow = (): Row => ({ description: "", qty: "1", unit: "ea", unit_price: "0", vat_rate: "20" });

export function PurchaseOrderBuilder({
  action,
  suppliers,
  jobs,
  initial,
  submitLabel,
}: {
  action: (prev: FormState<PurchaseOrderFormInput>, formData: FormData) => Promise<FormState<PurchaseOrderFormInput>>;
  suppliers: Option[];
  jobs: Option[];
  initial?: {
    supplier_id?: string | null;
    job_id?: string | null;
    supplier_reference?: string | null;
    expected_date?: string | null;
    notes?: string | null;
    line_items?: Array<{ description: string; qty: number; unit: string | null; unit_price: number; vat_rate: number }>;
  };
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);
  const router = useRouter();

  const [rows, setRows] = useState<Row[]>(
    initial?.line_items && initial.line_items.length > 0
      ? initial.line_items.map((li) => ({
          description: li.description,
          qty: String(li.qty),
          unit: li.unit ?? "ea",
          unit_price: String(li.unit_price),
          vat_rate: String(li.vat_rate),
        }))
      : [blankRow()],
  );

  useEffect(() => {
    if (state.ok && state.redirectTo) router.push(state.redirectTo);
  }, [state.ok, state.redirectTo, state.submittedAt, router]);

  const totals = useMemo(
    () =>
      computeTotals(
        rows.map((r) => ({
          description: r.description || "-",
          qty: Number(r.qty) || 0,
          unit: r.unit || "ea",
          unit_price: Number(r.unit_price) || 0,
          vat_rate: Number(r.vat_rate) || 0,
        })),
      ),
    [rows],
  );

  const lineItemsJson = JSON.stringify(
    rows
      .filter((r) => r.description.trim() !== "")
      .map((r) => ({
        description: r.description,
        qty: Number(r.qty) || 0,
        unit: r.unit || "ea",
        unit_price: Number(r.unit_price) || 0,
        vat_rate: Number(r.vat_rate) || 0,
      })),
  );

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  // DEFENCE-IN-DEPTH against the picker-class silent-null (F-1). The supplier list
  // is paged complete and the job list is a bounded recent-N sample; either way an
  // out-of-list SAVED id (editing an existing PO) must keep its <option>, or an
  // untouched save would NULL supplier_id / job_id. Preserve-inject both.
  const selectedSupplierId = initial?.supplier_id ?? "";
  const selectedJobId = initial?.job_id ?? "";
  const supplierOptions = withPreservedOption(
    suppliers,
    selectedSupplierId,
    (id) => ({ id, name: "Current supplier" }),
  );
  const jobOptions = withPreservedOption(jobs, selectedJobId, (id) => ({
    id,
    name: "Current job",
  }));

  return (
    <form action={formAction} className="space-y-5">
      {state.error ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </div>
      ) : null}
      {state.ok && state.successMessage ? (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {state.successMessage}
        </div>
      ) : null}

      <input type="hidden" name="line_items" value={lineItemsJson} />

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm font-medium text-slate-700">
          Supplier
          <select
            name="supplier_id"
            defaultValue={selectedSupplierId}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
          >
            <option value="">— None —</option>
            {supplierOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">
          Job (optional)
          <select
            name="job_id"
            defaultValue={selectedJobId}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
          >
            <option value="">— None —</option>
            {jobOptions.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm font-medium text-slate-700">
          Supplier reference
          <input
            name="supplier_reference"
            defaultValue={initial?.supplier_reference ?? ""}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
          />
        </label>
        <label className="text-sm font-medium text-slate-700">
          Expected date
          <input
            type="date"
            name="expected_date"
            defaultValue={initial?.expected_date ?? ""}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
          />
        </label>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Line items</h2>
          <button
            type="button"
            onClick={() => setRows((rs) => [...rs, blankRow()])}
            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            + Add line
          </button>
        </div>
        <div className="mt-2 space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-12 gap-2">
              <input
                aria-label="Description"
                placeholder="Description"
                value={r.description}
                onChange={(e) => setRow(i, { description: e.target.value })}
                className="col-span-5 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
              <input
                aria-label="Qty"
                type="number"
                step="0.01"
                value={r.qty}
                onChange={(e) => setRow(i, { qty: e.target.value })}
                className="col-span-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
              <input
                aria-label="Unit price"
                type="number"
                step="0.01"
                value={r.unit_price}
                onChange={(e) => setRow(i, { unit_price: e.target.value })}
                className="col-span-2 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              />
              <select
                aria-label="VAT rate"
                value={r.vat_rate}
                onChange={(e) => setRow(i, { vat_rate: e.target.value })}
                className="col-span-2 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              >
                {PO_VAT_RATES.map((v) => (
                  <option key={v} value={v}>
                    {v}% VAT
                  </option>
                ))}
              </select>
              <div className="col-span-1 flex items-center justify-end text-sm text-slate-600">
                {GBP.format(totals.lines[i]?.line_total ?? 0)}
              </div>
              <button
                type="button"
                aria-label="Remove line"
                onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs))}
                className="col-span-1 rounded-md text-xs text-slate-600 hover:text-red-600"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>

      <label className="block text-sm font-medium text-slate-700">
        Notes
        <textarea
          name="notes"
          rows={2}
          defaultValue={initial?.notes ?? ""}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
        />
      </label>

      <div className="flex items-center justify-between border-t border-slate-100 pt-4">
        <dl className="text-sm text-slate-600">
          <div className="flex gap-6">
            <dt>Subtotal</dt>
            <dd className="font-medium text-slate-900">{GBP.format(totals.subtotal)}</dd>
          </div>
          <div className="flex gap-6">
            <dt>VAT</dt>
            <dd className="font-medium text-slate-900">{GBP.format(totals.vat_total)}</dd>
          </div>
          <div className="flex gap-6 text-base">
            <dt className="font-semibold text-slate-900">Total</dt>
            <dd className="font-bold text-slate-900">{GBP.format(totals.total)}</dd>
          </div>
        </dl>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {pending ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
