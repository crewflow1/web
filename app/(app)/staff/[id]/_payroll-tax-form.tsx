"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { FormErrorBanner, FormSuccessBanner } from "@/components/forms/Field";
import { SubmitButton } from "@/components/forms/FormShell";
import { TAX_REGIONS, STUDENT_LOAN_PLANS, NI_CATEGORIES } from "@/lib/staff/schema";

type Values = Record<string, unknown>;
type Action = (
  prevState: FormState<Values>,
  formData: FormData,
) => Promise<FormState<Values>>;

type Defaults = {
  tax_region: string;
  student_loan_plan: string;
  salary_sacrifice_annual_pounds: string;
  ni_category: string;
  date_of_birth: string;
  standard_hours_per_day: string;
};

const NI_CATEGORY_LABEL: Record<string, string> = {
  A: "A — standard rate",
  B: "B — married women / widows reduced rate",
  C: "C — over State Pension age",
  J: "J — deferment",
  H: "H — apprentice under 25 (0% to UST)",
  M: "M — under 21 (0% to UST)",
  V: "V — veteran, first civilian job (0% to UST)",
  Z: "Z — under 21, deferment (0% to UST)",
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

        <label className="block text-xs text-slate-600">
          Employer NI category
          <select
            name="ni_category"
            defaultValue={pick("ni_category")}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
          >
            {NI_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {NI_CATEGORY_LABEL[c] ?? c}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs text-slate-600">
          Date of birth (for NI category check)
          <input
            type="date"
            name="date_of_birth"
            defaultValue={pick("date_of_birth")}
            aria-invalid={fe.date_of_birth ? true : undefined}
            className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-sm ${
              fe.date_of_birth ? "border-red-400" : "border-slate-300"
            }`}
          />
          {fe.date_of_birth ? (
            <p role="alert" className="mt-1 text-xs text-red-700">
              {fe.date_of_birth}
            </p>
          ) : null}
        </label>

        <label className="block text-xs text-slate-600 sm:col-span-2">
          Contracted hours per working day (for holiday pay)
          <input
            type="number"
            name="standard_hours_per_day"
            step={0.5}
            min={0}
            max={24}
            placeholder="e.g. 8 — leave blank for none"
            defaultValue={pick("standard_hours_per_day")}
            onFocus={(e) => e.currentTarget.select()}
            aria-invalid={fe.standard_hours_per_day ? true : undefined}
            className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-sm ${
              fe.standard_hours_per_day ? "border-red-400" : "border-slate-300"
            }`}
          />
          {fe.standard_hours_per_day ? (
            <p role="alert" className="mt-1 text-xs text-red-700">
              {fe.standard_hours_per_day}
            </p>
          ) : null}
        </label>
      </div>

      <p className="text-xs text-slate-500">
        These refine the take-home <strong>estimate</strong> on payroll runs: Scotland
        uses the Scottish income-tax bands, the plan adds student-loan repayments, and
        salary sacrifice reduces the PAYE/NI base. The <strong>NI category</strong> sets
        the employer-NI treatment (H/M/V/Z pay 0% employer NI up to the Upper Secondary
        Threshold); date of birth only powers a consistency check and never changes a
        figure. <strong>Contracted hours per working day</strong> converts approved
        holiday into holiday pay — leave it blank for no holiday pay. Defaults (Rest of
        UK, no loan, £0, category A, blank hours) leave pay unchanged. Still an estimate
        — confirm with HMRC Basic PAYE Tools before RTI.
      </p>

      <SubmitButton pending={pending}>Save payroll tax inputs</SubmitButton>
    </form>
  );
}
