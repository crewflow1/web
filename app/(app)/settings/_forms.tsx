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
import { Field } from "../_components/field";

type SettingsValues = Record<string, unknown>;
type SettingsAction = (
  prevState: FormState<SettingsValues>,
  formData: FormData,
) => Promise<FormState<SettingsValues>>;

function useSettingsState(action: SettingsAction) {
  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_FORM_STATE as FormState<SettingsValues>,
  );
  const router = useRouter();
  useEffect(() => {
    if (!state.ok) return;
    router.refresh();
  }, [state.ok, state.submittedAt, router]);
  return { state, formAction, pending };
}

function pickFrom(
  state: FormState<SettingsValues>,
  defaults: Record<string, string>,
  k: string,
  fb = "",
): string {
  const v = (state.values ?? {})[k];
  if (typeof v === "string" && v.length > 0) return v;
  return defaults[k] ?? fb;
}

export function ProfileForm({
  action,
  email,
  defaults,
}: {
  action: SettingsAction;
  email: string;
  defaults: { full_name: string; phone: string };
}) {
  const { state, formAction, pending } = useSettingsState(action);
  const fe = state.fieldErrors ?? {};

  return (
    <form action={formAction} noValidate className="mt-5 space-y-4">
      <FormErrorBanner error={state.error} />
      <FormSuccessBanner message={state.ok ? state.successMessage : null} />

      <div>
        <label className="block text-sm font-medium text-slate-800">Email</label>
        <p className="mt-1 text-sm text-slate-700">{email}</p>
        <p className="mt-1 text-xs text-slate-500">
          Email is tied to your sign-in. Contact us to change it.
        </p>
      </div>
      <Field
        name="full_name"
        label="Full name"
        required
        defaultValue={pickFrom(state, defaults, "full_name")}
        error={fe.full_name}
        autoComplete="name"
      />
      <Field
        name="phone"
        label="Phone"
        type="tel"
        inputMode="tel"
        optional
        defaultValue={pickFrom(state, defaults, "phone")}
        error={fe.phone}
        autoComplete="tel"
      />
      <SubmitButton pending={pending}>Save profile</SubmitButton>
    </form>
  );
}

type OrgDefaults = {
  name: string;
  phone: string;
  /** Org-level reply-to email — different from the owner's sign-in email. */
  org_email: string;
  vat_number: string;
  address_line1: string;
  address_city: string;
  address_postcode: string;
  default_terms: string;
  bank_name: string;
  bank_sort_code: string;
  bank_account_number: string;
  bank_reference: string;
};

export function OrganizationForm({
  action,
  isAdmin,
  defaults,
}: {
  action: SettingsAction;
  isAdmin: boolean;
  defaults: OrgDefaults;
}) {
  const { state, formAction, pending } = useSettingsState(action);
  const fe = state.fieldErrors ?? {};

  return (
    <form action={formAction} noValidate className="mt-5 space-y-4">
      <FormErrorBanner error={state.error} />
      <FormSuccessBanner message={state.ok ? state.successMessage : null} />

      <fieldset disabled={!isAdmin} className="space-y-4 disabled:opacity-60">
        <Field
          name="name"
          label="Trading name"
          required
          defaultValue={pickFrom(state, defaults, "name")}
          error={fe.name}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            name="phone"
            label="Phone"
            type="tel"
            inputMode="tel"
            optional
            defaultValue={pickFrom(state, defaults, "phone")}
            error={fe.phone}
          />
          <Field
            name="org_email"
            label="Reply-to email"
            type="email"
            inputMode="email"
            optional
            placeholder="ops@yourcompany.co.uk"
            defaultValue={pickFrom(state, defaults, "org_email")}
            error={fe.org_email}
          />
        </div>
        <Field
          name="vat_number"
          label="VAT number"
          optional
          placeholder="GB123456789"
          defaultValue={pickFrom(state, defaults, "vat_number")}
          error={fe.vat_number}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field
            name="address_line1"
            label="Address line 1"
            optional
            defaultValue={pickFrom(state, defaults, "address_line1")}
            error={fe.address_line1}
          />
          <Field
            name="address_city"
            label="City"
            optional
            defaultValue={pickFrom(state, defaults, "address_city")}
            error={fe.address_city}
          />
          <Field
            name="address_postcode"
            label="Postcode"
            optional
            defaultValue={pickFrom(state, defaults, "address_postcode")}
            error={fe.address_postcode}
          />
        </div>

        <div className="border-t border-slate-200 pt-5">
          <h3 className="text-sm font-semibold text-slate-900">
            Branding &amp; payment details
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Shown on quote and invoice PDFs sent to customers. Upload your logo
            in the Logo section above.
          </p>
          <div className="mt-4 space-y-4">
            <div>
              <label
                htmlFor="default_terms"
                className="block text-sm font-medium text-slate-800"
              >
                Default terms <span className="text-xs text-slate-400">Optional</span>
              </label>
              <textarea
                id="default_terms"
                name="default_terms"
                rows={4}
                defaultValue={pickFrom(state, defaults, "default_terms")}
                aria-invalid={fe.default_terms ? true : undefined}
                className={`mt-1.5 block w-full rounded-md border px-3 py-2.5 text-sm focus:outline-none focus:ring-1 ${
                  fe.default_terms
                    ? "border-red-400 focus:border-red-500 focus:ring-red-500"
                    : "border-slate-300 focus:border-slate-500 focus:ring-slate-500"
                }`}
                placeholder="50% deposit on acceptance, balance on completion. Materials warranty 12 months..."
              />
              {fe.default_terms ? (
                <p role="alert" className="mt-1 text-xs text-red-700">
                  {fe.default_terms}
                </p>
              ) : (
                <p className="mt-1 text-xs text-slate-500">
                  Pre-fills the Terms field on new quotes.
                </p>
              )}
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                name="bank_name"
                label="Bank account name"
                optional
                defaultValue={pickFrom(state, defaults, "bank_name")}
                error={fe.bank_name}
              />
              <Field
                name="bank_sort_code"
                label="Sort code"
                optional
                placeholder="20-00-00"
                defaultValue={pickFrom(state, defaults, "bank_sort_code")}
                error={fe.bank_sort_code}
              />
              <Field
                name="bank_account_number"
                label="Account number"
                optional
                placeholder="12345678"
                defaultValue={pickFrom(state, defaults, "bank_account_number")}
                error={fe.bank_account_number}
              />
              <Field
                name="bank_reference"
                label="Default reference"
                optional
                placeholder="Defaults to invoice/quote number"
                defaultValue={pickFrom(state, defaults, "bank_reference")}
                error={fe.bank_reference}
              />
            </div>
          </div>
        </div>
      </fieldset>
      {isAdmin ? (
        <SubmitButton pending={pending}>Save organisation</SubmitButton>
      ) : null}
    </form>
  );
}
