"use client";

import Link from "next/link";
import { useActionState } from "react";
import { FormShell, SubmitButton } from "@/components/forms/FormShell";
import { Field, SelectField, TextareaField } from "../_components/field";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { SITE_KINDS, SITE_KIND_HINTS, SITE_KIND_LABELS } from "@/lib/sites/schema";

/**
 * The add / edit site form — ONE component for both, so the two can never
 * drift into accepting different fields.
 *
 * `active` is NOT a field here. Retiring a depot re-labels every record that
 * points at it, so it is its own deliberate act with its own button and its own
 * copy on the detail page — never a checkbox someone flips by accident while
 * correcting a postcode.
 */

type SiteValues = Record<string, unknown>;

type ActionFn = (
  prev: FormState<SiteValues>,
  formData: FormData,
) => Promise<FormState<SiteValues>>;

export type SiteFormDefaults = {
  name?: string;
  kind?: string;
  address_line1?: string;
  address_line2?: string;
  city?: string;
  county?: string;
  postcode?: string;
  country?: string;
  notes?: string;
};

export function SiteForm({
  action,
  defaults,
  submitLabel,
  cancelHref,
}: {
  action: ActionFn;
  defaults?: SiteFormDefaults;
  submitLabel: string;
  cancelHref: string;
}) {
  const [state, formAction, pending] = useActionState<FormState<SiteValues>, FormData>(
    action,
    INITIAL_FORM_STATE,
  );

  const fieldErrors = state.fieldErrors ?? {};

  return (
    <FormShell state={state} action={formAction}>
      <Field
        name="name"
        label="Site name"
        required
        autoFocus
        placeholder="Wakefield yard"
        help="What people actually call it on the phone. One name per company — capitals are ignored."
        defaultValue={defaults?.name}
        error={fieldErrors.name}
      />

      <SelectField
        name="kind"
        label="What kind of place is it?"
        required
        options={SITE_KINDS.map((k) => ({
          value: k,
          label: `${SITE_KIND_LABELS[k]} — ${SITE_KIND_HINTS[k]}`,
        }))}
        defaultValue={defaults?.kind ?? "depot"}
        error={fieldErrors.kind}
      />

      <fieldset className="space-y-4 border-t border-slate-100 pt-5">
        <legend className="sr-only">Address</legend>
        <p className="text-sm font-semibold text-slate-900">
          Where it is
          <span className="ml-2 text-xs font-normal text-slate-500">
            All optional — a name alone is enough to start using it.
          </span>
        </p>
        <Field
          name="address_line1"
          label="Address line 1"
          optional
          autoComplete="address-line1"
          defaultValue={defaults?.address_line1}
          error={fieldErrors.address_line1}
        />
        <Field
          name="address_line2"
          label="Address line 2"
          optional
          autoComplete="address-line2"
          defaultValue={defaults?.address_line2}
          error={fieldErrors.address_line2}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            name="city"
            label="Town or city"
            optional
            autoComplete="address-level2"
            defaultValue={defaults?.city}
            error={fieldErrors.city}
          />
          <Field
            name="county"
            label="County"
            optional
            autoComplete="address-level1"
            defaultValue={defaults?.county}
            error={fieldErrors.county}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            name="postcode"
            label="Postcode"
            optional
            autoComplete="postal-code"
            placeholder="WF1 1AA"
            defaultValue={defaults?.postcode}
            error={fieldErrors.postcode}
          />
          <Field
            name="country"
            label="Country"
            optional
            autoComplete="country-name"
            defaultValue={defaults?.country ?? "United Kingdom"}
            error={fieldErrors.country}
          />
        </div>
      </fieldset>

      <TextareaField
        name="notes"
        label="Notes"
        rows={3}
        optional
        placeholder="Gate code, opening hours, who holds the key."
        defaultValue={defaults?.notes}
        error={fieldErrors.notes}
      />

      <div className="flex items-center gap-3 pt-2">
        <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
        <Link href={cancelHref} className="text-sm font-medium text-slate-600 hover:text-slate-900">
          Cancel
        </Link>
      </div>
    </FormShell>
  );
}
