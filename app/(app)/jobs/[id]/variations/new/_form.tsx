"use client";

import { useState } from "react";
import { computeVariation, VARIATION_VAT_RATES } from "@/lib/variations/schema";

/**
 * Variation form with live margin / revenue / VAT preview.
 *
 * State holds the 4 cost categories + margin + vat; computeVariation()
 * derives revenue, profit, totals in real time as the operator types.
 */

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

export function VariationForm({
  action,
}: {
  action: (formData: FormData) => void;
}) {
  const [labour, setLabour] = useState("0");
  const [materials, setMaterials] = useState("0");
  const [subs, setSubs] = useState("0");
  const [misc, setMisc] = useState("0");
  const [margin, setMargin] = useState("25");
  const [vat, setVat] = useState("20");

  const preview = computeVariation({
    labour_cost: Number(labour) || 0,
    materials_cost: Number(materials) || 0,
    subcontractor_cost: Number(subs) || 0,
    misc_cost: Number(misc) || 0,
    margin_pct: Number(margin) || 0,
    vat_rate: (Number(vat) as 0 | 5 | 20) || 0,
  });

  return (
    <form action={action} className="space-y-6">
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
        <Field label="Title" name="title" required placeholder="e.g. Additional bathroom tiling" />
        <Field
          label="Description"
          name="description"
          textarea
          rows={3}
          placeholder="What's the scope of this variation?"
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <MoneyField label="Labour" name="labour_cost" value={labour} onChange={setLabour} />
          <MoneyField
            label="Materials"
            name="materials_cost"
            value={materials}
            onChange={setMaterials}
          />
          <MoneyField
            label="Subcontractors"
            name="subcontractor_cost"
            value={subs}
            onChange={setSubs}
          />
          <MoneyField label="Misc" name="misc_cost" value={misc} onChange={setMisc} />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <NumField
            label="Target margin %"
            name="margin_pct"
            value={margin}
            onChange={setMargin}
            min={-50}
            max={95}
            step={1}
            help="Profit as a % of revenue. Affects price you charge."
          />
          <label className="block text-xs text-slate-600">
            VAT rate
            <select
              name="vat_rate"
              value={vat}
              onChange={(e) => setVat(e.target.value)}
              className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm"
            >
              {VARIATION_VAT_RATES.map((r) => (
                <option key={r} value={r}>
                  {r}%
                </option>
              ))}
            </select>
          </label>
        </div>

        <Field label="Internal note (optional)" name="note" textarea rows={2} />
        <Field
          label="Requested completion date — extension of time (optional)"
          name="eot_requested_completion_date"
          type="date"
          help="The completion date this variation asks for. Stored as an extension-of-time request on the variation — it is not a quote expiry, and it does not move this job's programme."
        />
      </div>

      {/* Live preview */}
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-6">
        <h2 className="text-sm font-semibold text-slate-900">Live preview</h2>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          <Preview label="Total cost" value={GBP.format(preview.total_cost)} />
          <Preview label="Revenue (net)" value={GBP.format(preview.subtotal)} />
          <Preview label="VAT" value={GBP.format(preview.vat_total)} />
          <Preview label="Gross profit" value={GBP.format(preview.gross_profit)} />
          <Preview label="Margin %" value={`${preview.margin_pct}%`} />
          <Preview label="Total inc. VAT" value={GBP.format(preview.total)} emphasis />
        </dl>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
        >
          Create variation
        </button>
        <p className="text-xs text-slate-500">
          You can review, send to the customer, and download a PDF on the next
          screen.
        </p>
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  type = "text",
  required = false,
  textarea = false,
  rows = 3,
  placeholder,
  help,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  textarea?: boolean;
  rows?: number;
  placeholder?: string;
  help?: string;
}) {
  return (
    <label className="block text-xs text-slate-600">
      {label}
      {textarea ? (
        <textarea
          name={name}
          required={required}
          rows={rows}
          placeholder={placeholder}
          className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
      ) : (
        <input
          type={type}
          name={name}
          required={required}
          placeholder={placeholder}
          className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
      )}
      {help ? <span className="mt-1 block text-[11px] text-slate-500">{help}</span> : null}
    </label>
  );
}

function MoneyField({
  label,
  name,
  value,
  onChange,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block text-xs text-slate-600">
      {label} (£)
      <input
        type="number"
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        min={0}
        step={0.01}
        className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
      />
    </label>
  );
}

function NumField({
  label,
  name,
  value,
  onChange,
  min,
  max,
  step,
  help,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  min: number;
  max: number;
  step: number;
  help?: string;
}) {
  return (
    <label className="block text-xs text-slate-600">
      {label}
      <input
        type="number"
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        min={min}
        max={max}
        step={step}
        className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
      />
      {help ? <span className="mt-1 block text-[11px] text-slate-500">{help}</span> : null}
    </label>
  );
}

function Preview({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd
        className={
          emphasis
            ? "mt-0.5 text-lg font-semibold text-slate-900"
            : "mt-0.5 text-sm font-medium text-slate-900"
        }
      >
        {value}
      </dd>
    </div>
  );
}
