"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { FormErrorBanner, FormSuccessBanner } from "@/components/forms/Field";
import { SubmitButton } from "@/components/forms/FormShell";
import { ACCRUAL_METHODS } from "@/lib/staff/schema";

type Values = Record<string, unknown>;
type Action = (
  prevState: FormState<Values>,
  formData: FormData,
) => Promise<FormState<Values>>;

type Defaults = {
  annual_allowance_days: string;
  accrual_method: string;
  carry_over_max_days: string;
  leave_year_start_month: string;
  leave_year_start_day: string;
};

const ACCRUAL_LABEL: Record<string, string> = {
  immediate: "Immediate (full allowance upfront)",
  monthly: "Monthly (accrues 1/12 per month)",
};

export function HolidayEntitlementForm({
  action,
  defaults,
}: {
  action: Action;
  defaults: Defaults;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_FORM_STATE as FormState<Values>,
  );
  const router = useRouter();
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, state.submittedAt, router]);

  const v = (state.values ?? {}) as Record<string, unknown>;
  const fe = state.fieldErrors ?? {};
  const pick = (k: keyof Defaults): string => {
    const fromState = v[k];
    if (typeof fromState === "string" && fromState.length > 0) return fromState;
    return defaults[k];
  };

  return (
    <form action={formAction} className="mt-3 space-y-3" noValidate>
      <FormErrorBanner error={state.error} />
      <FormSuccessBanner message={state.ok ? state.successMessage : null} />

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Num
          label="Annual allowance (days)"
          name="annual_allowance_days"
          step={0.5}
          defaultValue={pick("annual_allowance_days")}
          error={fe.annual_allowance_days}
        />
        <label className="block text-xs text-slate-600">
          Accrual method
          <select
            name="accrual_method"
            defaultValue={pick("accrual_method")}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            {ACCRUAL_METHODS.map((m) => (
              <option key={m} value={m}>
                {ACCRUAL_LABEL[m] ?? m}
              </option>
            ))}
          </select>
        </label>
        <Num
          label="Carry-over max (days)"
          name="carry_over_max_days"
          step={0.5}
          defaultValue={pick("carry_over_max_days")}
          error={fe.carry_over_max_days}
        />
        <div className="grid grid-cols-2 gap-2">
          <Num
            label="Leave-year start month"
            name="leave_year_start_month"
            step={1}
            defaultValue={pick("leave_year_start_month")}
            error={fe.leave_year_start_month}
          />
          <Num
            label="day"
            name="leave_year_start_day"
            step={1}
            defaultValue={pick("leave_year_start_day")}
            error={fe.leave_year_start_day}
          />
        </div>
      </div>
      <SubmitButton pending={pending}>Save entitlement</SubmitButton>
    </form>
  );
}

function Num({
  label,
  name,
  step,
  defaultValue,
  error,
}: {
  label: string;
  name: string;
  step: number;
  defaultValue: string;
  error?: string;
}) {
  const errorId = error ? `${name}-error` : undefined;
  return (
    <label className="block text-xs text-slate-600">
      {label}
      <input
        type="number"
        name={name}
        step={step}
        min={0}
        defaultValue={defaultValue}
        onFocus={(e) => e.currentTarget.select()}
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
