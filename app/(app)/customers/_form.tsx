"use client";

import { useActionState } from "react";
import Link from "next/link";
import {
  INITIAL_FORM_STATE,
  type FormState,
} from "@/lib/forms/state";
import {
  FormErrorBanner,
  FormSuccessBanner,
} from "@/components/forms/Field";
import { SubmitButton } from "@/components/forms/FormShell";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Field, TextareaField, SelectField } from "../_components/field";
import type { CustomerFormInput } from "@/lib/customers/schema";

/** A candidate parent business the operator can roll this customer up under. */
export type ParentOption = { id: string; name: string };

/**
 * Client form for create/edit-customer.
 *
 * Drives a server action via `useActionState` so the entire form state
 * (per-field errors, form-level error, success banner) round-trips
 * through React 19 without a redirect — input survives validation
 * failures because the action echoes `values` back.
 */

type CustomerAction = (
  prevState: FormState<CustomerFormInput>,
  formData: FormData,
) => Promise<FormState<CustomerFormInput>>;

export function CustomerForm({
  action,
  submitLabel,
  cancelHref,
  defaults,
  parentOptions = [],
}: {
  action: CustomerAction;
  submitLabel: string;
  cancelHref: string;
  defaults?: Partial<CustomerFormInput>;
  /** Business customers in the org this record can roll up under (excl. self). */
  parentOptions?: ParentOption[];
}) {
  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_FORM_STATE as FormState<CustomerFormInput>,
  );
  const router = useRouter();

  useEffect(() => {
    if (!state.ok) return;
    if (state.redirectTo) {
      router.push(state.redirectTo);
      return;
    }
    router.refresh();
  }, [state.ok, state.redirectTo, state.submittedAt, router]);

  const v = state.values ?? {};

  return (
    <form
      action={formAction}
      noValidate
      className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <FormErrorBanner error={state.error} />
      {/* L2: suppress the banner when we're about to redirect (create flow),
          so the new-customer save navigates straight to the detail page
          without a "Customer saved." flash. Edit flows have no redirectTo,
          so they still show the in-place "Saved." confirmation. */}
      <FormSuccessBanner
        message={state.ok && !state.redirectTo ? state.successMessage : null}
      />

      <Field
        name="name"
        label="Name"
        required
        autoFocus
        placeholder="e.g. Sarah Murphy"
        autoComplete="name"
        defaultValue={v.name ?? defaults?.name ?? ""}
        error={state.fieldErrors?.name}
      />
      <Field
        name="email"
        label="Email"
        type="email"
        optional
        placeholder="sarah@example.com"
        autoComplete="email"
        defaultValue={v.email ?? defaults?.email ?? ""}
        error={state.fieldErrors?.email}
      />
      <Field
        name="phone"
        label="Phone"
        type="tel"
        inputMode="tel"
        optional
        placeholder="+44 7700 900123"
        autoComplete="tel"
        defaultValue={v.phone ?? defaults?.phone ?? ""}
        error={state.fieldErrors?.phone}
      />

      <fieldset className="space-y-4 rounded-lg border border-slate-200 p-4">
        <legend className="px-1 text-sm font-semibold text-slate-700">
          Business
        </legend>
        <SelectField
          name="customer_type"
          label="Customer type"
          options={[
            { value: "individual", label: "Individual" },
            { value: "business", label: "Business" },
          ]}
          defaultValue={
            v.customer_type ?? defaults?.customer_type ?? "individual"
          }
          help="Businesses can carry a company number, VAT number, and roll-up sites."
          error={state.fieldErrors?.customer_type}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            name="company_number"
            label="Company number"
            optional
            placeholder="12345678"
            defaultValue={
              v.company_number ?? defaults?.company_number ?? ""
            }
            error={state.fieldErrors?.company_number}
          />
          <Field
            name="vat_number"
            label="VAT number"
            optional
            placeholder="GB123456789"
            defaultValue={v.vat_number ?? defaults?.vat_number ?? ""}
            error={state.fieldErrors?.vat_number}
          />
        </div>
        {parentOptions.length > 0 ? (
          <SelectField
            name="parent_customer_id"
            label="Parent business"
            options={[
              { value: "", label: "— None (top-level) —" },
              ...parentOptions.map((p) => ({ value: p.id, label: p.name })),
            ]}
            defaultValue={
              v.parent_customer_id ?? defaults?.parent_customer_id ?? ""
            }
            help="Roll this record up under a business account (e.g. a site or contact)."
            error={state.fieldErrors?.parent_customer_id}
          />
        ) : null}
      </fieldset>

      <fieldset className="space-y-4 rounded-lg border border-slate-200 p-4">
        <legend className="px-1 text-sm font-semibold text-slate-700">
          Address
        </legend>
        <Field
          name="address_line1"
          label="Address line 1"
          optional
          placeholder="12 Shankill Road"
          autoComplete="address-line1"
          defaultValue={v.address_line1 ?? defaults?.address_line1 ?? ""}
          error={state.fieldErrors?.address_line1}
        />
        <Field
          name="address_line2"
          label="Address line 2"
          optional
          autoComplete="address-line2"
          defaultValue={v.address_line2 ?? defaults?.address_line2 ?? ""}
          error={state.fieldErrors?.address_line2}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            name="city"
            label="City / Town"
            optional
            placeholder="Belfast"
            autoComplete="address-level2"
            defaultValue={v.city ?? defaults?.city ?? ""}
            error={state.fieldErrors?.city}
          />
          <Field
            name="county"
            label="County"
            optional
            placeholder="Antrim"
            autoComplete="address-level1"
            defaultValue={v.county ?? defaults?.county ?? ""}
            error={state.fieldErrors?.county}
          />
          <Field
            name="postcode"
            label="Postcode"
            optional
            placeholder="BT13 2AB"
            autoComplete="postal-code"
            defaultValue={v.postcode ?? defaults?.postcode ?? ""}
            error={state.fieldErrors?.postcode}
          />
          <Field
            name="country"
            label="Country"
            optional
            placeholder="United Kingdom"
            autoComplete="country-name"
            defaultValue={v.country ?? defaults?.country ?? "United Kingdom"}
            error={state.fieldErrors?.country}
          />
        </div>
      </fieldset>

      <TextareaField
        name="notes"
        label="Notes"
        optional
        rows={4}
        placeholder="Anything worth remembering — preferred call times, gate codes, etc."
        defaultValue={v.notes ?? defaults?.notes ?? ""}
        error={state.fieldErrors?.notes}
      />

      <div className="flex items-center gap-3">
        <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
        <Link
          href={cancelHref}
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
