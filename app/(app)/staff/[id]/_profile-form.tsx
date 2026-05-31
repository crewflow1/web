"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  INITIAL_FORM_STATE,
  type FormState,
} from "@/lib/forms/state";
import {
  FormErrorBanner,
  FormSuccessBanner,
} from "@/components/forms/Field";
import { SubmitButton } from "@/components/forms/FormShell";
import { EMPLOYMENT_TYPES } from "@/lib/staff/schema";

type ProfileValues = Record<string, unknown>;
type ProfileAction = (
  prevState: FormState<ProfileValues>,
  formData: FormData,
) => Promise<FormState<ProfileValues>>;

type Defaults = {
  full_name?: string;
  phone?: string;
  hourly_pay?: string;
  employment_type?: string;
  start_date?: string;
  emergency_contact_name?: string;
  emergency_contact_phone?: string;
  emergency_contact_relationship?: string;
};

export function StaffProfileForm({
  action,
  isAdmin,
  defaults,
}: {
  action: ProfileAction;
  isAdmin: boolean;
  defaults: Defaults;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_FORM_STATE as FormState<ProfileValues>,
  );
  const router = useRouter();

  useEffect(() => {
    if (!state.ok) return;
    router.refresh();
  }, [state.ok, state.submittedAt, router]);

  const v = (state.values ?? {}) as Record<string, unknown>;
  const fe = state.fieldErrors ?? {};
  const pick = (k: keyof Defaults, fallback = ""): string => {
    const fromState = v[k];
    if (typeof fromState === "string" && fromState.length > 0) return fromState;
    return defaults[k] ?? fallback;
  };

  return (
    <form action={formAction} className="mt-4 space-y-3" noValidate>
      <FormErrorBanner error={state.error} />
      <FormSuccessBanner message={state.ok ? state.successMessage : null} />

      <Pair
        label="Full name"
        name="full_name"
        defaultValue={pick("full_name")}
        error={fe.full_name}
        disabled={!isAdmin}
      />
      <Pair
        label="Phone"
        name="phone"
        defaultValue={pick("phone")}
        error={fe.phone}
        disabled={!isAdmin}
      />
      <Pair
        label="Hourly pay (£)"
        name="hourly_pay"
        type="number"
        step={0.01}
        defaultValue={pick("hourly_pay")}
        error={fe.hourly_pay}
        disabled={!isAdmin}
      />
      <label className="block text-xs text-slate-600">
        Employment type
        <select
          name="employment_type"
          defaultValue={pick("employment_type")}
          disabled={!isAdmin}
          aria-invalid={fe.employment_type ? true : undefined}
          className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm disabled:opacity-60"
        >
          <option value="">—</option>
          {EMPLOYMENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t.replace("_", " ")}
            </option>
          ))}
        </select>
        {fe.employment_type ? (
          <p role="alert" className="mt-1 text-xs text-red-700">
            {fe.employment_type}
          </p>
        ) : null}
      </label>
      <Pair
        label="Start date"
        name="start_date"
        type="date"
        defaultValue={pick("start_date")}
        error={fe.start_date}
        disabled={!isAdmin}
      />
      <div>
        <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Emergency contact
        </div>
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Pair
            label="Name"
            name="emergency_contact_name"
            defaultValue={pick("emergency_contact_name")}
            error={fe.emergency_contact_name}
            disabled={!isAdmin}
          />
          <Pair
            label="Phone"
            name="emergency_contact_phone"
            defaultValue={pick("emergency_contact_phone")}
            error={fe.emergency_contact_phone}
            disabled={!isAdmin}
          />
          <Pair
            label="Relationship"
            name="emergency_contact_relationship"
            defaultValue={pick("emergency_contact_relationship")}
            error={fe.emergency_contact_relationship}
            disabled={!isAdmin}
          />
        </div>
      </div>
      {isAdmin ? (
        <SubmitButton pending={pending}>Save profile</SubmitButton>
      ) : (
        <p className="text-xs text-slate-500">
          Only admins can edit profile fields.
        </p>
      )}
    </form>
  );
}

function Pair({
  label,
  name,
  defaultValue,
  type = "text",
  step,
  disabled = false,
  error,
}: {
  label: string;
  name: string;
  defaultValue: string;
  type?: string;
  step?: number;
  disabled?: boolean;
  error?: string;
}) {
  const errorId = error ? `${name}-error` : undefined;
  return (
    <label className="block text-xs text-slate-600">
      {label}
      <input
        type={type}
        name={name}
        defaultValue={defaultValue}
        step={step}
        disabled={disabled}
        // Select-on-focus for numeric fields only (e.g. Hourly pay), so the
        // prefilled value is replaced rather than appended to (H1). Text
        // fields like name/phone keep normal cursor-placement behaviour.
        onFocus={type === "number" ? (e) => e.currentTarget.select() : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-sm disabled:opacity-60 ${
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
