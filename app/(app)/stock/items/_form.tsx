"use client";

import Link from "next/link";
import { useActionState, useEffect } from "react";
import { FormErrorBanner, FormSuccessBanner } from "@/components/forms/Field";
import { SubmitButton } from "@/components/forms/FormShell";
import { Field, SelectField, TextareaField } from "../../_components/field";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { COMMON_STOCK_UNITS } from "@/lib/stock/schema";

/**
 * The add / edit stock-item form — ONE component for both, so the two can never
 * drift into accepting different fields.
 *
 * `active` is NOT a field here. Retiring an item removes it from every picker,
 * so it is its own deliberate act with its own button on the detail page, never
 * a checkbox someone flips while fixing a unit.
 *
 * THE ACCOUNTING BOUNDARY: there is deliberately NO price or cost field on this
 * form, and there is nowhere to put one. Stock is quantities; the money already
 * landed when the supplier's bill was recorded. A unit cost here would be the
 * first step towards double-counting every material a job uses.
 *
 * HARD NAVIGATION on success rather than router.push: this form sits four route
 * segments deep on the edit path, which is exactly where Next 15.5 silently
 * drops a client-side navigation — the server work lands and the URL never
 * moves, so the user re-submits. `window.location.assign` cannot be dropped.
 */

type ItemValues = Record<string, unknown>;

type ActionFn = (
  prev: FormState<ItemValues>,
  formData: FormData,
) => Promise<FormState<ItemValues>>;

export type StockItemFormDefaults = {
  name?: string;
  description?: string;
  sku?: string;
  unit?: string;
  preferred_supplier_id?: string;
  supplier_reference?: string;
  reorder_level?: string;
  target_level?: string;
  notes?: string;
};

export function StockItemForm({
  action,
  defaults,
  suppliers,
  submitLabel,
  cancelHref,
}: {
  action: ActionFn;
  defaults?: StockItemFormDefaults;
  suppliers: Array<{ id: string; name: string }>;
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction, pending] = useActionState<FormState<ItemValues>, FormData>(
    action,
    INITIAL_FORM_STATE,
  );

  useEffect(() => {
    if (state.ok && state.redirectTo) window.location.assign(state.redirectTo);
  }, [state.ok, state.redirectTo, state.submittedAt]);

  const fieldErrors = state.fieldErrors ?? {};

  return (
    <form
      action={formAction}
      className="space-y-5 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"
      noValidate
    >
      <FormErrorBanner error={state.error} />
      <FormSuccessBanner message={state.ok ? state.successMessage : null} />

      <Field
        name="name"
        label="What is it?"
        required
        autoFocus
        placeholder="Cement 25kg bag"
        help="What people actually ask for. One name per company — capitals are ignored."
        defaultValue={defaults?.name}
        error={fieldErrors.name}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="unit" className="block text-sm font-medium text-slate-800">
            Counted in<span className="ml-0.5 text-red-500">*</span>
          </label>
          <input
            id="unit"
            name="unit"
            list="stock-units"
            required
            defaultValue={defaults?.unit ?? "ea"}
            placeholder="bag"
            aria-invalid={fieldErrors.unit ? true : undefined}
            className={`mt-1.5 block w-full rounded-md border px-3 py-2.5 text-base focus:outline-none focus:ring-1 sm:text-sm ${
              fieldErrors.unit
                ? "border-red-400 focus:border-red-500 focus:ring-red-500"
                : "border-slate-300 focus:border-slate-500 focus:ring-slate-500"
            }`}
          />
          {/* A datalist, NOT a select: UK merchanting units are unbounded and
              regional, so "lin m" and "pack of 100" must always be typeable. */}
          <datalist id="stock-units">
            {COMMON_STOCK_UNITS.map((u) => (
              <option key={u} value={u} />
            ))}
          </datalist>
          {fieldErrors.unit ? (
            <p role="alert" className="mt-1 text-xs text-red-700">
              {fieldErrors.unit}
            </p>
          ) : (
            <p className="mt-1 text-xs text-slate-500">
              Bags, sheets, metres, each. Two items measured differently are two items.
            </p>
          )}
        </div>

        <Field
          name="sku"
          label="Your code"
          optional
          placeholder="CEM-25"
          help="Only if you use codes. Leave blank otherwise."
          defaultValue={defaults?.sku}
          error={fieldErrors.sku}
        />
      </div>

      <fieldset className="space-y-4 border-t border-slate-100 pt-5">
        <legend className="sr-only">Reordering</legend>
        <p className="text-sm font-semibold text-slate-900">
          Tell me when it runs low
          <span className="ml-2 text-xs font-normal text-slate-500">
            Both optional — leave blank and this item is never flagged.
          </span>
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            name="reorder_level"
            label="Reorder level"
            optional
            type="number"
            inputMode="decimal"
            placeholder="20"
            help="Flagged when you reach this, not after it."
            defaultValue={defaults?.reorder_level}
            error={fieldErrors.reorder_level}
          />
          <Field
            name="target_level"
            label="Target level"
            optional
            type="number"
            inputMode="decimal"
            placeholder="100"
            help="What a full shelf looks like — used to suggest how many to order."
            defaultValue={defaults?.target_level}
            error={fieldErrors.target_level}
          />
        </div>
      </fieldset>

      <fieldset className="space-y-4 border-t border-slate-100 pt-5">
        <legend className="sr-only">Buying it</legend>
        <p className="text-sm font-semibold text-slate-900">
          Where you buy it
          <span className="ml-2 text-xs font-normal text-slate-500">
            So a re-order does not need hunting for.
          </span>
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            name="preferred_supplier_id"
            label="Usual supplier"
            options={[
              { value: "", label: "— none —" },
              ...suppliers.map((s) => ({ value: s.id, label: s.name })),
            ]}
            defaultValue={defaults?.preferred_supplier_id ?? ""}
            error={fieldErrors.preferred_supplier_id}
          />
          <Field
            name="supplier_reference"
            label="Their code for it"
            optional
            defaultValue={defaults?.supplier_reference}
            error={fieldErrors.supplier_reference}
          />
        </div>
      </fieldset>

      <TextareaField
        name="description"
        label="Description"
        optional
        rows={2}
        placeholder="Portland CEM II, 25kg paper sack"
        defaultValue={defaults?.description}
        error={fieldErrors.description}
      />

      <TextareaField
        name="notes"
        label="Notes"
        optional
        rows={2}
        defaultValue={defaults?.notes}
        error={fieldErrors.notes}
      />

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-5">
        <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
        <Link href={cancelHref} className="text-sm font-medium text-slate-600 hover:text-slate-900">
          Cancel
        </Link>
      </div>
    </form>
  );
}
