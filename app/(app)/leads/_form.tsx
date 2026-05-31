"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
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
import {
  Field,
  TextareaField,
  SelectField,
} from "../_components/field";
import {
  LEAD_SOURCES,
  LEAD_URGENCIES,
} from "@/lib/leads/schema";

/**
 * Client form for create/edit-lead. Drives a server action via
 * `useActionState` so per-field errors and form-level errors surface
 * inline. Echoed `values` from the action repopulate the inputs so
 * the user never re-types after a validation failure.
 *
 * Action accepts/returns FormState with a `Record<string, unknown>`
 * values shape — both `createLeadSchema` and `updateLeadSchema` infer
 * compatibly without forcing the form to know which path was taken.
 */

type LeadValues = Record<string, unknown>;

type LeadAction = (
  prevState: FormState<LeadValues>,
  formData: FormData,
) => Promise<FormState<LeadValues>>;

export function LeadForm({
  action,
  submitLabel,
  cancelHref,
  customers,
  staff,
  defaults,
}: {
  action: LeadAction;
  submitLabel: string;
  cancelHref: string;
  customers: { id: string; name: string }[];
  staff: { id: string; full_name: string | null; email: string }[];
  defaults?: Partial<Record<string, string | number | null | undefined>>;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_FORM_STATE as FormState<LeadValues>,
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

  const v = (state.values ?? {}) as Record<string, unknown>;
  const fe = state.fieldErrors ?? {};
  const pick = (k: string, fallback = "") => {
    const fromState = v[k];
    if (typeof fromState === "string" && fromState.length > 0) return fromState;
    const fromDefaults = defaults?.[k];
    if (fromDefaults === undefined || fromDefaults === null) return fallback;
    return String(fromDefaults);
  };

  return (
    <form
      action={formAction}
      noValidate
      className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"
    >
      <FormErrorBanner error={state.error} />
      {/* L2: suppress the banner when we're about to redirect (create flow)
          so the save navigates straight to the detail page without a flash.
          Edit flows have no redirectTo, so they keep the in-place banner. */}
      <FormSuccessBanner
        message={state.ok && !state.redirectTo ? state.successMessage : null}
      />

      <fieldset className="space-y-4 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
          Who got in touch
        </legend>
        <Field
          name="contact_name"
          label="Name"
          required
          placeholder="e.g. Sarah Murphy"
          autoComplete="name"
          defaultValue={pick("contact_name")}
          error={fe.contact_name}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field
            name="contact_email"
            label="Email"
            type="email"
            placeholder="sarah@example.com"
            autoComplete="email"
            defaultValue={pick("contact_email")}
            error={fe.contact_email}
            help="Email or phone is required."
          />
          <Field
            name="contact_phone"
            label="Phone"
            type="tel"
            inputMode="tel"
            placeholder="+44 7700 900123"
            autoComplete="tel"
            defaultValue={pick("contact_phone")}
            error={fe.contact_phone}
            help="Email or phone is required."
          />
        </div>
      </fieldset>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SelectField
          name="source"
          label="Source"
          required
          defaultValue={pick("source", "phone")}
          options={LEAD_SOURCES.map((s) => ({ value: s, label: s }))}
          error={fe.source}
        />
        <SelectField
          name="urgency"
          label="Urgency"
          defaultValue={pick("urgency", "normal")}
          options={LEAD_URGENCIES.map((u) => ({ value: u, label: u }))}
          error={fe.urgency}
        />
      </div>

      <Field
        name="service"
        label="Service / scope"
        optional
        placeholder="e.g. Storm damage repair"
        defaultValue={pick("service")}
        error={fe.service}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <SelectField
          name="customer_id"
          label="Customer"
          defaultValue={pick("customer_id")}
          options={[
            { value: "", label: "— None / new enquirer —" },
            ...customers.map((c) => ({ value: c.id, label: c.name })),
          ]}
          error={fe.customer_id}
        />
        <SelectField
          name="assigned_to"
          label="Assigned to"
          defaultValue={pick("assigned_to")}
          options={[
            { value: "", label: "— Unassigned —" },
            ...staff.map((s) => ({
              value: s.id,
              label: s.full_name ?? s.email,
            })),
          ]}
          error={fe.assigned_to}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field
          name="postcode"
          label="Postcode"
          optional
          placeholder="BT15 1AA"
          defaultValue={pick("postcode")}
          error={fe.postcode}
        />
        <Field
          name="estimated_value"
          label="Estimated value (£)"
          type="number"
          inputMode="decimal"
          optional
          placeholder="0.00"
          defaultValue={pick("estimated_value")}
          error={fe.estimated_value}
        />
      </div>

      <TextareaField
        name="notes"
        label="Notes"
        optional
        rows={3}
        placeholder="Anything worth remembering."
        defaultValue={pick("notes")}
        error={fe.notes}
      />

      <TextareaField
        name="ai_summary"
        label="AI / call summary"
        optional
        rows={3}
        placeholder="Auto-fills from the AI receptionist when wired up (Slice 6)."
        defaultValue={pick("ai_summary")}
        error={fe.ai_summary}
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
