"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { FormErrorBanner, FormSuccessBanner } from "@/components/forms/Field";
import { SubmitButton } from "@/components/forms/FormShell";
import { TAX_REGIONS, STUDENT_LOAN_PLANS } from "@/lib/staff/schema";

type Values = Record<string, unknown>;
type Action = (
  prevState: FormState<Values>,
  formData: FormData,
) => Promise<FormState<Values>>;

type Defaults = {
  tax_region: string;
  student_loan_plan: string;
  salary_sacrifice_annual_pounds: string;
};

const REGION_LABEL: Record<string, string> = {
  rest_of_uk: "Rest of UK (England / Wales / NI)",
  scotland: "Scotland (S tax code)",
};

const PLAN_LABEL: Record<string, string> = {
  none: "No student loan",
  plan_1: "Plan 1",
  plan_2: "Plan 2",
  plan_4: "Plan 4 (Scotland)",
  plan_5: "Plan 5 (post-2023 undergraduate)",
  postgraduate: "Postgraduate loan",
};

export function PayrollTaxProfileForm({
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
          Income-tax region
          <select
            name="tax_region"
            defaultValue={pick("tax_region")}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            {TAX_REGIONS.map((r) => (
              <option key={r} value={r}>
                {REGION_LABEL[r] ?? r}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-slate-600">
          Student-loan plan
          <select
            name="student_loan_plan"
            defaultValue={pick("student_loan_plan")}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            {STUDENT_LOAN_PLANS.map((p) => (
              <option key={p} value={p}>
                {PLAN_LABEL[p] ?? p}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-slate-600 sm:col-span-2">
          Salary sacrifice (£ / year)
          <input
            type="number"
            name="salary_sacrifice_annual_pounds"
            step={1}
            min={0}
            defaultValue={pick("salary_sacrifice_annual_pounds")}
            onFocus={(e) => e.currentTarget.select()}
            aria-invalid={fe.salary_sacrifice_annual_pounds ? true : undefined}
            aria-describedby={
              fe.salary_sacrifice_annual_pounds
                ? "salary_sacrifice_annual_pounds-error"
                : undefined
            }
            className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-sm ${
              fe.salary_sacrifice_annual_pounds ? "border-red-400" : "border-slate-300"
            }`}
          />
          {fe.salary_sacrifice_annual_pounds ? (
            <p
              id="salary_sacrifice_annual_pounds-error"
              role="alert"
              className="mt-1 text-xs text-red-700"
            >
              {fe.salary_sacrifice_annual_pounds}
            </p>
          ) : null}
        </label>
      </div>

      <p className="text-xs text-slate-500">
        These refine the take-home <strong>estimate</strong> on payroll runs: Scotland
        uses the Scottish income-tax bands, the plan adds student-loan repayments, and
        salary sacrifice reduces the PAYE/NI base. Defaults (Rest of UK, no loan, £0)
        leave pay unchanged. Still an estimate — confirm with HMRC Basic PAYE Tools
        before RTI.
      </p>

      <SubmitButton pending={pending}>Save payroll tax inputs</SubmitButton>
    </form>
  );
}
