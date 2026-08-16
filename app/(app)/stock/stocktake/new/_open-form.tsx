"use client";

import Link from "next/link";
import { useActionState, useEffect } from "react";
import { FormErrorBanner } from "@/components/forms/Field";
import { SubmitButton } from "@/components/forms/FormShell";
import { Field, SelectField, TextareaField } from "../../../_components/field";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { openStocktakeSession } from "../../stocktake-actions";

/**
 * Open a stocktake. HARD NAVIGATION on success (window.location.assign) rather
 * than router.push — the create lands and we jump to the new session; the stock
 * surface's documented Next 15.5 deep-swap posture.
 */
export function OpenStocktakeForm({
  sites,
}: {
  sites: Array<{ id: string; name: string; kind: string }>;
}) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    openStocktakeSession,
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

      <SelectField
        name="site_id"
        label="Where are you counting?"
        required
        options={[
          { value: "", label: "— pick a place —" },
          ...sites.map((s) => ({ value: s.id, label: `${s.name} (${s.kind})` })),
        ]}
        error={fieldErrors.site_id}
      />

      <Field
        name="reference"
        label="Name this count"
        optional
        placeholder="Q3 lock-up count"
        help="Just a handle so you can find it later."
        error={fieldErrors.reference}
      />

      <TextareaField
        name="notes"
        label="Notes"
        optional
        rows={2}
        placeholder="Anything worth remembering about this count."
        error={fieldErrors.notes}
      />

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-100 pt-5">
        <SubmitButton pending={pending}>Freeze &amp; start</SubmitButton>
        <Link href="/stock/stocktake" className="text-sm font-medium text-slate-600 hover:text-slate-900">
          Cancel
        </Link>
      </div>
    </form>
  );
}
