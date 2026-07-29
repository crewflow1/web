"use client";

import { type ReactNode } from "react";

/**
 * Reusable form-field row. Renders the label, the input (children), an
 * optional helper line, and an inline error sourced from a FormState
 * `fieldErrors` map. Mirrors the design language of the existing demo
 * + invite-staff modals.
 *
 * Usage:
 *   <Field name="email" label="Email" required error={state.fieldErrors.email}>
 *     <input name="email" type="email" defaultValue={state.values.email ?? ""} />
 *   </Field>
 */
export function Field({
  name,
  label,
  required,
  optional,
  help,
  error,
  children,
}: {
  /** Form-field name — must match the input's `name` for ARIA wiring. */
  name: string;
  label: string;
  required?: boolean;
  optional?: boolean;
  help?: string;
  error?: string;
  children: ReactNode;
}) {
  const errorId = `${name}-error`;
  return (
    <label className="block text-xs font-medium text-slate-700" htmlFor={name}>
      <span className="flex items-baseline justify-between">
        <span>
          {label}
          {required ? <span className="ml-0.5 text-red-500">*</span> : null}
        </span>
        {optional ? <span className="text-[10px] font-normal text-slate-500">Optional</span> : null}
      </span>
      {children}
      {help && !error ? (
        <span className="mt-1 block text-[11px] font-normal text-slate-500">{help}</span>
      ) : null}
      {error ? (
        <span
          id={errorId}
          role="alert"
          className="mt-1 block text-[11px] font-normal text-red-700"
        >
          {error}
        </span>
      ) : null}
    </label>
  );
}

/** Field-level error sourced from a FormState `fieldErrors` map. Lookup is null-safe. */
export function fieldError(
  fieldErrors: Record<string, string> | undefined,
  name: string,
): string | undefined {
  return fieldErrors?.[name];
}

/**
 * Form-level error banner. Renders nothing when `error` is null/empty.
 * Mirrors the `role="alert"` + red-50 pattern used elsewhere.
 */
export function FormErrorBanner({ error }: { error: string | null | undefined }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
    >
      {error}
    </div>
  );
}

/**
 * Success banner — paired with the FormState `successMessage` field.
 * Renders nothing when message is absent.
 */
export function FormSuccessBanner({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <div
      role="status"
      className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700"
    >
      {message}
    </div>
  );
}
