"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import {
  FormErrorBanner,
  FormSuccessBanner,
} from "@/components/forms/Field";
import { SubmitButton } from "@/components/forms/FormShell";
import {
  VAT_RATES,
  CIS_RATES,
  CIS_RATE_LABEL,
  MONTH_LABEL,
  VAT_STAGGER_LABEL,
  VAT_SCHEME_LABEL,
  type TaxDefaults,
} from "@/lib/org-config/schema";
import { VAT_STAGGERS, VAT_SCHEMES } from "@/lib/tax/compute";

type Action = (
  prev: FormState,
  formData: FormData,
) => Promise<FormState>;

const selectClass =
  "mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";

/**
 * Tax & defaults editor — a self-contained client form. Four bounded config
 * values (default VAT rate, CIS default rate, financial-year start month,
 * default payment terms). Disabled wholesale for non-admins; the DB + action
 * enforce admin-write regardless.
 */
export function TaxDefaultsForm({
  defaults,
  isAdmin,
  action,
}: {
  defaults: TaxDefaults;
  isAdmin: boolean;
  action: Action;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);
  const router = useRouter();
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, state.submittedAt, router]);

  const fe = state.fieldErrors ?? {};

  return (
    <form action={formAction} noValidate className="mt-5 space-y-4">
      <FormErrorBanner error={state.error} />
      <FormSuccessBanner message={state.ok ? state.successMessage : null} />

      <fieldset disabled={!isAdmin} className="space-y-4 disabled:opacity-60">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="default_vat_rate" className="block text-sm font-medium text-slate-800">
              Default VAT rate
            </label>
            <select
              id="default_vat_rate"
              name="default_vat_rate"
              defaultValue={String(defaults.default_vat_rate)}
              className={selectClass}
            >
              {VAT_RATES.map((r) => (
                <option key={r} value={r}>
                  {r}%
                </option>
              ))}
            </select>
            {fe.default_vat_rate ? (
              <p role="alert" className="mt-1 text-xs text-red-700">{fe.default_vat_rate}</p>
            ) : (
              <p className="mt-1 text-xs text-slate-500">Pre-fills the VAT rate on new quotes and invoices.</p>
            )}
          </div>

          <div>
            <label htmlFor="cis_default_rate" className="block text-sm font-medium text-slate-800">
              Default CIS deduction rate
            </label>
            <select
              id="cis_default_rate"
              name="cis_default_rate"
              defaultValue={String(defaults.cis_default_rate)}
              className={selectClass}
            >
              {CIS_RATES.map((r) => (
                <option key={r} value={r}>
                  {CIS_RATE_LABEL[r]}
                </option>
              ))}
            </select>
            {fe.cis_default_rate ? (
              <p role="alert" className="mt-1 text-xs text-red-700">{fe.cis_default_rate}</p>
            ) : (
              <p className="mt-1 text-xs text-slate-500">Verified subcontractor status still overrides this per subcontractor.</p>
            )}
          </div>

          <div>
            <label htmlFor="financial_year_start_month" className="block text-sm font-medium text-slate-800">
              Financial year starts
            </label>
            <select
              id="financial_year_start_month"
              name="financial_year_start_month"
              defaultValue={String(defaults.financial_year_start_month)}
              className={selectClass}
            >
              {Object.entries(MONTH_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            {fe.financial_year_start_month ? (
              <p role="alert" className="mt-1 text-xs text-red-700">{fe.financial_year_start_month}</p>
            ) : (
              <p className="mt-1 text-xs text-slate-500">The month your accounting year begins (UK default: April).</p>
            )}
          </div>

          <div>
            <label htmlFor="default_payment_terms_days" className="block text-sm font-medium text-slate-800">
              Default payment terms (days)
            </label>
            <input
              id="default_payment_terms_days"
              name="default_payment_terms_days"
              type="number"
              min={0}
              max={365}
              inputMode="numeric"
              defaultValue={String(defaults.default_payment_terms_days)}
              aria-invalid={fe.default_payment_terms_days ? true : undefined}
              className={selectClass}
            />
            {fe.default_payment_terms_days ? (
              <p role="alert" className="mt-1 text-xs text-red-700">{fe.default_payment_terms_days}</p>
            ) : (
              <p className="mt-1 text-xs text-slate-500">How long new invoices are due after issue (0 = on receipt).</p>
            )}
          </div>

          <div className="sm:col-span-2">
            <label htmlFor="vat_stagger" className="block text-sm font-medium text-slate-800">
              VAT return period (stagger)
            </label>
            <select
              id="vat_stagger"
              name="vat_stagger"
              defaultValue={defaults.vat_stagger}
              className={selectClass}
            >
              {VAT_STAGGERS.map((s) => (
                <option key={s} value={s}>
                  {VAT_STAGGER_LABEL[s]}
                </option>
              ))}
            </select>
            {fe.vat_stagger ? (
              <p role="alert" className="mt-1 text-xs text-red-700">{fe.vat_stagger}</p>
            ) : (
              <p className="mt-1 text-xs text-slate-500">
                HMRC assigns your quarterly stagger (or monthly returns) when you register. This selects which VAT period the tax dashboard and returns are computed for.
              </p>
            )}
          </div>

          <div className="sm:col-span-2">
            <label htmlFor="vat_scheme" className="block text-sm font-medium text-slate-800">
              VAT accounting scheme
            </label>
            <select
              id="vat_scheme"
              name="vat_scheme"
              defaultValue={defaults.vat_scheme}
              className={selectClass}
            >
              {VAT_SCHEMES.map((s) => (
                <option key={s} value={s}>
                  {VAT_SCHEME_LABEL[s]}
                </option>
              ))}
            </select>
            {fe.vat_scheme ? (
              <p role="alert" className="mt-1 text-xs text-red-700">{fe.vat_scheme}</p>
            ) : (
              <p className="mt-1 text-xs text-slate-500">
                Cash accounting (the default) counts output VAT when an invoice is paid; standard/accrual counts it at the invoice date. Input VAT is on your logged costs under both. Change this only to match the scheme HMRC has you on.
              </p>
            )}
          </div>
        </div>
      </fieldset>

      {isAdmin ? (
        <SubmitButton pending={pending}>Save tax &amp; defaults</SubmitButton>
      ) : null}
    </form>
  );
}
