"use client";

import { useActionState } from "react";
import { FormShell, SubmitButton } from "@/components/forms/FormShell";
import { Field, TextareaField } from "../_components/field";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import Link from "next/link";

/**
 * Phase D — Supplier form (create + edit).
 */

type SupplierValues = Record<string, unknown>;

type ActionFn = (
  prev: FormState<SupplierValues>,
  formData: FormData,
) => Promise<FormState<SupplierValues>>;

export function SupplierForm({
  action,
  defaults,
  submitLabel,
  cancelHref,
}: {
  action: ActionFn;
  defaults?: {
    name?: string;
    phone?: string;
    email?: string;
    category?: string;
    notes?: string;
    payment_terms_days?: string;
  };
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction, pending] = useActionState<
    FormState<SupplierValues>,
    FormData
  >(action, INITIAL_FORM_STATE);

  const fieldErrors = state.fieldErrors ?? {};

  return (
    <FormShell state={state} action={formAction}>
      <Field
        name="name"
        label="Supplier name"
        required
        autoFocus
        defaultValue={defaults?.name}
        error={fieldErrors.name}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="email"
          label="Email"
          type="email"
          optional
          defaultValue={defaults?.email}
          error={fieldErrors.email}
        />
        <Field
          name="phone"
          label="Phone"
          type="tel"
          optional
          defaultValue={defaults?.phone}
          error={fieldErrors.phone}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="category"
          label="Category"
          optional
          placeholder="e.g. Plant hire, Materials, Subcontractor"
          defaultValue={defaults?.category}
          error={fieldErrors.category}
        />
        <Field
          name="payment_terms_days"
          label="Payment terms (days)"
          type="number"
          inputMode="numeric"
          optional
          placeholder="e.g. 30"
          help="Days after the bill date a supplier's invoice is due. Leave blank if not agreed — bills then age assuming 30 days."
          defaultValue={defaults?.payment_terms_days}
          error={fieldErrors.payment_terms_days}
        />
      </div>
      <TextareaField
        name="notes"
        label="Notes"
        rows={3}
        optional
        defaultValue={defaults?.notes}
        error={fieldErrors.notes}
      />
      <div className="flex items-center gap-3 pt-2">
        <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
        <Link
          href={cancelHref}
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Cancel
        </Link>
      </div>
    </FormShell>
  );
}
