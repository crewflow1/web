"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { FormErrorBanner, FormSuccessBanner } from "@/components/forms/Field";
import { SubmitButton } from "@/components/forms/FormShell";
import {
  QUALIFICATION_TYPES,
  QUALIFICATION_TYPE_LABELS,
} from "@/lib/staff/qualifications";

type Values = Record<string, unknown>;
type Action = (
  prevState: FormState<Values>,
  formData: FormData,
) => Promise<FormState<Values>>;

/**
 * Admin-only form to record a qualification against a member. Mirrors the
 * holiday-entitlement form's useActionState + router.refresh pattern (the staff
 * detail route is not a force-dynamic [id] route, so this is safe here). On a
 * successful add the form is reset so the next entry starts blank.
 */
export function AddQualificationForm({
  action,
  defaults,
}: {
  action: Action;
  /** Prefill from a certificate/CSCS-card import (qualification_type/title/
   *  reference_no/issued_on/expires_on/notes). */
  defaults?: Record<string, string>;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_FORM_STATE as FormState<Values>,
  );
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) {
      formRef.current?.reset();
      router.refresh();
    }
  }, [state.ok, state.submittedAt, router]);

  const fe = state.fieldErrors ?? {};

  return (
    <form ref={formRef} action={formAction} className="mt-4 space-y-3" noValidate>
      <FormErrorBanner error={state.error} />
      <FormSuccessBanner message={state.ok ? state.successMessage : null} />

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block text-xs text-slate-600">
          Type
          <select
            name="qualification_type"
            defaultValue={
              defaults?.qualification_type &&
              (QUALIFICATION_TYPES as readonly string[]).includes(defaults.qualification_type)
                ? defaults.qualification_type
                : "cscs"
            }
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            {QUALIFICATION_TYPES.map((t) => (
              <option key={t} value={t}>
                {QUALIFICATION_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <Text
          label="Name / grade"
          name="title"
          placeholder="e.g. CSCS Blue Skilled Worker"
          error={fe.title}
          defaultValue={defaults?.title}
        />
        <Text
          label="Reference no. (optional)"
          name="reference_no"
          placeholder="Card / certificate number"
          error={fe.reference_no}
          defaultValue={defaults?.reference_no}
        />
        <div className="grid grid-cols-2 gap-2">
          <DateInput label="Issued on" name="issued_on" error={fe.issued_on} defaultValue={defaults?.issued_on} />
          <DateInput label="Expires on" name="expires_on" error={fe.expires_on} defaultValue={defaults?.expires_on} />
        </div>
      </div>
      <label className="block text-xs text-slate-600">
        Notes (optional)
        <textarea
          name="notes"
          rows={2}
          defaultValue={defaults?.notes ?? ""}
          className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
        />
        {fe.notes ? (
          <span role="alert" className="mt-1 block text-xs text-red-700">
            {fe.notes}
          </span>
        ) : null}
      </label>
      <SubmitButton pending={pending}>Add qualification</SubmitButton>
    </form>
  );
}

function Text({
  label,
  name,
  placeholder,
  error,
  defaultValue,
}: {
  label: string;
  name: string;
  placeholder?: string;
  error?: string;
  defaultValue?: string;
}) {
  const errorId = error ? `${name}-error` : undefined;
  return (
    <label className="block text-xs text-slate-600">
      {label}
      <input
        type="text"
        name={name}
        placeholder={placeholder}
        defaultValue={defaultValue ?? ""}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-sm ${
          error ? "border-red-400" : "border-slate-300"
        }`}
      />
      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </label>
  );
}

function DateInput({
  label,
  name,
  error,
  defaultValue,
}: {
  label: string;
  name: string;
  error?: string;
  defaultValue?: string;
}) {
  const errorId = error ? `${name}-error` : undefined;
  return (
    <label className="block text-xs text-slate-600">
      {label}
      <input
        type="date"
        name={name}
        defaultValue={defaultValue ?? ""}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-sm ${
          error ? "border-red-400" : "border-slate-300"
        }`}
      />
      {error ? (
        <p id={errorId} role="alert" className="mt-1 text-xs text-red-700">
          {error}
        </p>
      ) : null}
    </label>
  );
}
