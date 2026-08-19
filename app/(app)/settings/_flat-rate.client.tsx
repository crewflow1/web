"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { FormErrorBanner, FormSuccessBanner } from "@/components/forms/Field";
import { SubmitButton } from "@/components/forms/FormShell";
import type { FlatRateSchemeConfig } from "@/lib/tax/compute";

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

const inputClass =
  "mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500";

const LIMITED_COST_LABEL: Record<FlatRateSchemeConfig["limited_cost"], string> = {
  unset: "Not yet declared — files at the conservative 16.5%",
  yes: "Yes — limited-cost business (16.5%)",
  no: "No — not a limited-cost business (use my sector rate)",
};

/**
 * VAT Flat Rate Scheme editor — a self-contained client form over the seven FRS
 * config fields. Disabled wholesale for non-admins; the DB + action enforce
 * admin-write regardless. The computation lives in the single VAT authority
 * (lib/tax/compute.ts); this only captures the config.
 */
export function FlatRateForm({
  config,
  isAdmin,
  action,
}: {
  config: FlatRateSchemeConfig;
  isAdmin: boolean;
  action: Action;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);
  const router = useRouter();
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, state.submittedAt, router]);

  const fe = state.fieldErrors ?? {};

  const limitedCostUndeclared = config.enabled && config.limited_cost === "unset";

  return (
    <form action={formAction} noValidate className="mt-5 space-y-4">
      <FormErrorBanner error={state.error} />
      <FormSuccessBanner message={state.ok ? state.successMessage : null} />

      {limitedCostUndeclared ? (
        <div
          role="alert"
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
        >
          <strong>Declare your limited-cost status.</strong> Until you set
          &ldquo;Limited-cost trader&rdquo; to Yes or No below, your VAT returns file
          at the conservative <strong>16.5%</strong> flat rate. This never
          under-declares, but if you are not a limited-cost business you may be paying
          more VAT than you owe — set it to your correct status and save.
        </div>
      ) : null}

      <fieldset disabled={!isAdmin} className="space-y-4 disabled:opacity-60">
        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            name="frs_enabled"
            defaultChecked={config.enabled}
            className="mt-1 h-4 w-4 rounded border-slate-300"
          />
          <span>
            <span className="block text-sm font-medium text-slate-800">
              Use the Flat Rate Scheme
            </span>
            <span className="mt-0.5 block text-xs text-slate-500">
              When on, VAT due is the flat percentage of gross (VAT-inclusive)
              turnover; input VAT on purchases is not reclaimed.
            </span>
          </span>
        </label>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="frs_sector_percent" className="block text-sm font-medium text-slate-800">
              FRS sector percentage
            </label>
            <input
              id="frs_sector_percent"
              name="frs_sector_percent"
              type="number"
              min={0}
              max={20}
              step="0.1"
              inputMode="decimal"
              defaultValue={String(config.sector_percent)}
              aria-invalid={fe.sector_percent ? true : undefined}
              className={inputClass}
            />
            {fe.sector_percent ? (
              <p role="alert" className="mt-1 text-xs text-red-700">{fe.sector_percent}</p>
            ) : (
              <p className="mt-1 text-xs text-slate-500">Your HMRC trade-sector rate (e.g. 9.5%).</p>
            )}
          </div>

          <div>
            <label htmlFor="frs_limited_cost" className="block text-sm font-medium text-slate-800">
              Limited-cost trader
            </label>
            <select
              id="frs_limited_cost"
              name="frs_limited_cost"
              defaultValue={config.limited_cost}
              className={inputClass}
            >
              {(Object.keys(LIMITED_COST_LABEL) as FlatRateSchemeConfig["limited_cost"][]).map(
                (k) => (
                  <option key={k} value={k}>
                    {LIMITED_COST_LABEL[k]}
                  </option>
                ),
              )}
            </select>
            {fe.limited_cost ? (
              <p role="alert" className="mt-1 text-xs text-red-700">{fe.limited_cost}</p>
            ) : (
              <p className="mt-1 text-xs text-slate-500">
                HMRC&rsquo;s limited-cost test compares your spend on <em>goods</em> (not services, labour, rent or software) with your turnover. We can&rsquo;t split that from your costs, so you must declare it. Until you do, returns file at the safe 16.5%.
              </p>
            )}
          </div>

          <div>
            <label htmlFor="frs_registration_date" className="block text-sm font-medium text-slate-800">
              VAT registration date
            </label>
            <input
              id="frs_registration_date"
              name="frs_registration_date"
              type="date"
              defaultValue={config.registration_date ?? ""}
              aria-invalid={fe.registration_date ? true : undefined}
              className={inputClass}
            />
            {fe.registration_date ? (
              <p role="alert" className="mt-1 text-xs text-red-700">{fe.registration_date}</p>
            ) : (
              <p className="mt-1 text-xs text-slate-500">Anchors the 1% first-year discount window.</p>
            )}
          </div>

          <div>
            <label className="flex items-start gap-3 sm:mt-7">
              <input
                type="checkbox"
                name="frs_first_year_discount"
                defaultChecked={config.first_year_discount}
                className="mt-1 h-4 w-4 rounded border-slate-300"
              />
              <span>
                <span className="block text-sm font-medium text-slate-800">
                  Apply the 1% first-year discount
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  Takes 1 point off the rate for your first year of VAT registration.
                </span>
              </span>
            </label>
          </div>

          <div>
            <label htmlFor="frs_effective_from" className="block text-sm font-medium text-slate-800">
              FRS effective from
            </label>
            <input
              id="frs_effective_from"
              name="frs_effective_from"
              type="date"
              defaultValue={config.effective_from ?? ""}
              aria-invalid={fe.effective_from ? true : undefined}
              className={inputClass}
            />
            {fe.effective_from ? (
              <p role="alert" className="mt-1 text-xs text-red-700">{fe.effective_from}</p>
            ) : (
              <p className="mt-1 text-xs text-slate-500">Returns before this date use your normal scheme. Blank = no lower bound.</p>
            )}
          </div>

          <div>
            <label htmlFor="frs_effective_to" className="block text-sm font-medium text-slate-800">
              FRS effective to
            </label>
            <input
              id="frs_effective_to"
              name="frs_effective_to"
              type="date"
              defaultValue={config.effective_to ?? ""}
              aria-invalid={fe.effective_to ? true : undefined}
              className={inputClass}
            />
            {fe.effective_to ? (
              <p role="alert" className="mt-1 text-xs text-red-700">{fe.effective_to}</p>
            ) : (
              <p className="mt-1 text-xs text-slate-500">Set when you leave the scheme. Blank = open-ended.</p>
            )}
          </div>
        </div>
      </fieldset>

      {isAdmin ? (
        <SubmitButton pending={pending}>Save Flat Rate Scheme</SubmitButton>
      ) : null}
    </form>
  );
}
