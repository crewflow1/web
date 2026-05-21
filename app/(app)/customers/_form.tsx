"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  INITIAL_FORM_STATE,
  type FormState,
} from "@/lib/forms/state";
import {
  FormErrorBanner,
  FormSuccessBanner,
} from "@/components/forms/Field";
import { SubmitButton } from "@/components/forms/FormShell";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Field, TextareaField } from "../_components/field";
import type { CustomerFormInput } from "@/lib/customers/schema";

/**
 * Client form for create/edit-customer.
 *
 * Drives a server action via `useActionState` so the entire form state
 * (per-field errors, form-level error, success banner) round-trips
 * through React 19 without a redirect — input survives validation
 * failures because the action echoes `values` back.
 */

type CustomerAction = (
  prevState: FormState<CustomerFormInput>,
  formData: FormData,
) => Promise<FormState<CustomerFormInput>>;

export function CustomerForm({
  action,
  submitLabel,
  cancelHref,
  defaults,
}: {
  action: CustomerAction;
  submitLabel: string;
  cancelHref: string;
  defaults?: Partial<CustomerFormInput>;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_FORM_STATE as FormState<CustomerFormInput>,
  );
  const router = useRouter();

  useEffect(() => {
    if (!state.ok) return;
    if (state.redirectTo) {
      router.push(state.redirectTo);
      return;
    }
    router.refresh();
  }, [state.ok, state.redirectTo, state.submittedAt, router]);

  const v = state.values ?? {};

  return (
    <form
      action={formAction}
      noValidate
      className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <FormErrorBanner error={state.error} />
      <FormSuccessBanner message={state.ok ? state.successMessage : null} />

      <Field
        name="name"
        label="Name"
        required
        placeholder="e.g. Sarah Murphy"
        autoComplete="name"
        defaultValue={v.name ?? defaults?.name ?? ""}
        error={state.fieldErrors?.name}
      />
      <Field
        name="email"
        label="Email"
        type="email"
        optional
        placeholder="sarah@example.com"
        autoComplete="email"
        defaultValue={v.email ?? defaults?.email ?? ""}
        error={state.fieldErrors?.email}
      />
      <Field
        name="phone"
        label="Phone"
        type="tel"
        inputMode="tel"
        optional
        placeholder="+44 7700 900123"
        autoComplete="tel"
        defaultValue={v.phone ?? defaults?.phone ?? ""}
        error={state.fieldErrors?.phone}
      />
      <TextareaField
        name="notes"
        label="Notes"
        optional
        rows={4}
        placeholder="Anything worth remembering — preferred call times, gate codes, etc."
        defaultValue={v.notes ?? defaults?.notes ?? ""}
        error={state.fieldErrors?.notes}
      />

      <div className="flex items-center gap-3">
        <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
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
