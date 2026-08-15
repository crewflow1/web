"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import type { QuoteTemplateInput } from "@/lib/pricing/schema";

/**
 * "Save as template" — turns this quote's saved lines into a reusable template.
 *
 * The action reads the quote's PERSISTED line items server-side (org-pinned), so
 * this panel only needs a name + optional job type. Unlike the price-book picker
 * (which reads the live builder state), saving works off what's stored, so it
 * captures the quote as last saved — the honest, deterministic source.
 */

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-50 disabled:opacity-60"
    >
      {pending ? "Saving…" : "Save as template"}
    </button>
  );
}

export function SaveAsTemplatePanel({
  action,
}: {
  action: (
    prev: FormState<QuoteTemplateInput>,
    formData: FormData,
  ) => Promise<FormState<QuoteTemplateInput>>;
}) {
  const [state, formAction] = useActionState<FormState<QuoteTemplateInput>, FormData>(
    action,
    INITIAL_FORM_STATE as FormState<QuoteTemplateInput>,
  );

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-semibold text-slate-900">Reuse this quote</h2>
      <p className="mt-1 text-xs text-slate-600">
        Save these lines as a template you can apply to a future quote. Manage
        your templates under Price book.
      </p>
      <form action={formAction} className="mt-3 flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="tpl-name" className="block text-xs font-medium text-slate-600">
            Template name <span className="text-red-500">*</span>
          </label>
          <input
            id="tpl-name"
            name="name"
            required
            placeholder="e.g. Bathroom refit"
            aria-invalid={!!state.fieldErrors?.name}
            className="mt-1 block w-56 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </div>
        <div>
          <label htmlFor="tpl-job-type" className="block text-xs font-medium text-slate-600">
            Job type <span className="text-slate-400">Optional</span>
          </label>
          <input
            id="tpl-job-type"
            name="job_type"
            placeholder="Bathroom"
            className="mt-1 block w-44 rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </div>
        <Submit />
      </form>
      {state.error ? (
        <p role="alert" className="mt-2 text-xs text-red-700">{state.error}</p>
      ) : null}
      {state.fieldErrors?.name ? (
        <p role="alert" className="mt-2 text-xs text-red-700">{state.fieldErrors.name}</p>
      ) : null}
      {state.ok && state.successMessage ? (
        <p role="status" className="mt-2 text-xs text-emerald-700">{state.successMessage}</p>
      ) : null}
    </section>
  );
}
