"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { FormErrorBanner, FormSuccessBanner } from "@/components/forms/Field";
import { SubmitButton } from "@/components/forms/FormShell";
import { PENSION_STATUSES } from "@/lib/staff/schema";

type Values = Record<string, unknown>;
type Action = (
  prevState: FormState<Values>,
  formData: FormData,
) => Promise<FormState<Values>>;

type Defaults = {
  status: string;
  employee_contribution_percent: string;
  employer_contribution_percent: string;
  scheme_name: string;
  assessment_date: string;
  enrolment_date: string;
  opt_out_date: string;
  postponement_end_date: string;
};

const STATUS_LABEL: Record<string, string> = {
  not_enrolled: "Not enrolled",
  enrolled: "Enrolled",
  opted_out: "Opted out",
  postponed: "Postponed",
};

export function PensionEnrolmentForm({
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
        <label className="block text-xs text-slate-600">
          Enrolment status
          <select
            name="status"
            defaultValue={pick("status")}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            {PENSION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s] ?? s}
              </option>
            ))}
          </select>
        </label>
        <Field
          label="Scheme name"
          name="scheme_name"
          type="text"
          defaultValue={pick("scheme_name")}
          error={fe.scheme_name}
        />
        <Field
          label="Employee contribution (%)"
          name="employee_contribution_percent"
          type="number"
          step={0.1}
          defaultValue={pick("employee_contribution_percent")}
          error={fe.employee_contribution_percent}
        />
        <Field
          label="Employer contribution (%)"
          name="employer_contribution_percent"
          type="number"
          step={0.1}
          defaultValue={pick("employer_contribution_percent")}
          error={fe.employer_contribution_percent}
        />
        <Field
          label="Assessment date"
          name="assessment_date"
          type="date"
          defaultValue={pick("assessment_date")}
          error={fe.assessment_date}
        />
        <Field
          label="Enrolment date"
          name="enrolment_date"
          type="date"
          defaultValue={pick("enrolment_date")}
          error={fe.enrolment_date}
        />
        <Field
          label="Opt-out date"
          name="opt_out_date"
          type="date"
          defaultValue={pick("opt_out_date")}
          error={fe.opt_out_date}
        />
        <Field
          label="Postponement end date"
          name="postponement_end_date"
          type="date"
          defaultValue={pick("postponement_end_date")}
          error={fe.postponement_end_date}
        />
      </div>
      <SubmitButton pending={pending}>Save pension enrolment</SubmitButton>
    </form>
  );
}

function Field({
  label,
  name,
  type,
  step,
  defaultValue,
  error,
}: {
  label: string;
  name: string;
  type: string;
  step?: number;
  defaultValue: string;
  error?: string;
}) {
  const errorId = error ? `${name}-error` : undefined;
  return (
    <label className="block text-xs text-slate-600">
      {label}
      <input
        type={type}
        name={name}
        step={step}
        min={type === "number" ? 0 : undefined}
        defaultValue={defaultValue}
        onFocus={type === "number" ? (e) => e.currentTarget.select() : undefined}
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
