"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useFormStatus } from "react-dom";
import {
  INITIAL_FORM_STATE,
  type FormState,
} from "@/lib/forms/state";
import {
  QUOTE_VAT_RATES,
  type PriceBookItemInput,
  type QuoteTemplateInput,
} from "@/lib/pricing/schema";

/**
 * /pricing client forms.
 *
 * Money is entered in POUNDS (matching the quote builder); the server converts
 * to integer pence. Field errors render inline; the form-level banner carries
 * anything else. On success the form either navigates (redirectTo) or refreshes
 * the list in place.
 */

function Submit({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-60"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

const inputCls =
  "mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";

type PriceBookAction = (
  prev: FormState<PriceBookItemInput>,
  formData: FormData,
) => Promise<FormState<PriceBookItemInput>>;

export function PriceBookItemForm({
  action,
  submitLabel,
  pendingLabel,
  initial,
  resetOnSuccess = false,
}: {
  action: PriceBookAction;
  submitLabel: string;
  pendingLabel: string;
  /** Edit-mode defaults. `unit_price` in POUNDS. */
  initial?: Partial<PriceBookItemInput>;
  resetOnSuccess?: boolean;
}) {
  const [state, formAction] = useActionState<FormState<PriceBookItemInput>, FormData>(
    action,
    INITIAL_FORM_STATE as FormState<PriceBookItemInput>,
  );
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!state.ok) return;
    if (state.redirectTo) {
      router.push(state.redirectTo);
      return;
    }
    if (resetOnSuccess) formRef.current?.reset();
    router.refresh();
  }, [state.ok, state.redirectTo, state.submittedAt, resetOnSuccess, router]);

  const v = (state.values ?? {}) as Partial<PriceBookItemInput>;
  const dflt = <K extends keyof PriceBookItemInput>(k: K): string => {
    const fromEcho = v[k];
    if (fromEcho !== undefined && fromEcho !== null) return String(fromEcho);
    const fromInitial = initial?.[k];
    return fromInitial !== undefined && fromInitial !== null ? String(fromInitial) : "";
  };
  const err = (k: string) => state.fieldErrors?.[k];
  const activeChecked =
    v.active !== undefined ? Boolean(v.active) : initial?.active ?? true;

  return (
    <form action={formAction} ref={formRef} className="space-y-4" noValidate>
      {state.error ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}
      {state.ok && state.successMessage && !state.redirectTo ? (
        <p role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {state.successMessage}
        </p>
      ) : null}

      <div>
        <label htmlFor="pb-description" className="block text-sm font-medium text-slate-800">
          Description <span className="text-red-500">*</span>
        </label>
        <input
          id="pb-description"
          name="description"
          required
          defaultValue={dflt("description")}
          placeholder="e.g. Supply & fit slate tile — per m²"
          aria-invalid={!!err("description")}
          className={inputCls}
        />
        {err("description") ? (
          <p role="alert" className="mt-1 text-xs text-red-700">{err("description")}</p>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="pb-code" className="block text-sm font-medium text-slate-800">
            Code / SKU <span className="text-xs text-slate-500">Optional</span>
          </label>
          <input id="pb-code" name="code" defaultValue={dflt("code")} placeholder="ROOF-01" className={inputCls} />
        </div>
        <div>
          <label htmlFor="pb-category" className="block text-sm font-medium text-slate-800">
            Category <span className="text-xs text-slate-500">Optional</span>
          </label>
          <input id="pb-category" name="category" defaultValue={dflt("category")} placeholder="Roofing" className={inputCls} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor="pb-unit" className="block text-sm font-medium text-slate-800">
            Unit
          </label>
          <input id="pb-unit" name="unit" defaultValue={dflt("unit") || "ea"} placeholder="ea" className={inputCls} />
        </div>
        <div>
          <label htmlFor="pb-price" className="block text-sm font-medium text-slate-800">
            Unit price (£) <span className="text-red-500">*</span>
          </label>
          <input
            id="pb-price"
            name="unit_price"
            type="number"
            step="0.01"
            min="0"
            required
            defaultValue={dflt("unit_price")}
            placeholder="0.00"
            aria-invalid={!!err("unit_price")}
            className={inputCls}
          />
          {err("unit_price") ? (
            <p role="alert" className="mt-1 text-xs text-red-700">{err("unit_price")}</p>
          ) : null}
        </div>
        <div>
          <label htmlFor="pb-vat" className="block text-sm font-medium text-slate-800">
            VAT %
          </label>
          <select id="pb-vat" name="vat_rate" defaultValue={dflt("vat_rate") || "20"} className={inputCls}>
            {QUOTE_VAT_RATES.map((r) => (
              <option key={r} value={r}>{r}%</option>
            ))}
          </select>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-800">
        {/* Hidden default so an unchecked box still posts a falsey value. */}
        <input type="hidden" name="active" value="false" />
        <input type="checkbox" name="active" value="true" defaultChecked={activeChecked} className="h-4 w-4 rounded border-slate-300" />
        Active (available in the quote picker)
      </label>

      <div className="flex items-center gap-3 pt-2">
        <Submit label={submitLabel} pendingLabel={pendingLabel} />
      </div>
    </form>
  );
}

/**
 * A tiny inline form that posts a single hidden field to a FormState action and
 * refreshes on success — used for archive/restore/delete row controls.
 */
export function InlineActionButton({
  action,
  hidden,
  label,
  confirm,
  className,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  hidden: Record<string, string>;
  label: string;
  confirm?: string;
  className?: string;
}) {
  const [state, formAction] = useActionState<FormState, FormData>(
    action,
    INITIAL_FORM_STATE,
  );
  const router = useRouter();
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, state.submittedAt, router]);

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      className="inline"
    >
      {Object.entries(hidden).map(([k, val]) => (
        <input key={k} type="hidden" name={k} value={val} />
      ))}
      <button
        type="submit"
        title={state.error ?? undefined}
        className={
          className ??
          "rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
        }
      >
        {label}
      </button>
    </form>
  );
}

type TemplateRenameAction = (
  prev: FormState<QuoteTemplateInput>,
  formData: FormData,
) => Promise<FormState<QuoteTemplateInput>>;

/** Inline rename for a saved template (name + job type). */
export function TemplateRenameForm({
  action,
  initial,
}: {
  action: TemplateRenameAction;
  initial: { name: string; job_type: string | null };
}) {
  const [state, formAction] = useActionState<FormState<QuoteTemplateInput>, FormData>(
    action,
    INITIAL_FORM_STATE as FormState<QuoteTemplateInput>,
  );
  const router = useRouter();
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, state.submittedAt, router]);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <div>
        <label className="block text-xs font-medium text-slate-600">Name</label>
        <input
          name="name"
          required
          defaultValue={initial.name}
          className="mt-1 block w-48 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-600">Job type</label>
        <input
          name="job_type"
          defaultValue={initial.job_type ?? ""}
          placeholder="Optional"
          className="mt-1 block w-40 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </div>
      <button
        type="submit"
        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
      >
        Save
      </button>
      {state.error ? <span className="text-xs text-red-700">{state.error}</span> : null}
      {state.ok ? <span className="text-xs text-emerald-700">Saved</span> : null}
    </form>
  );
}
