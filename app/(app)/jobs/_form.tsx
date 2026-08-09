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
import { withPreservedOption } from "@/lib/quotes/preserve-option";

type JobValues = Record<string, unknown>;

type JobAction = (
  prevState: FormState<JobValues>,
  formData: FormData,
) => Promise<FormState<JobValues>>;

export function JobForm({
  action,
  submitLabel,
  cancelHref,
  customers,
  staff,
  defaults,
}: {
  action: JobAction;
  submitLabel: string;
  cancelHref: string;
  customers: { id: string; name: string }[];
  staff: { id: string; full_name: string | null; email: string }[];
  defaults?: Partial<Record<string, string | null | undefined>>;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_FORM_STATE as FormState<JobValues>,
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

  // DEFENCE-IN-DEPTH against the picker-class silent-null (F-1). The readers now
  // page these lists complete, but a future cap/typeahead — or simply a saved id
  // that is not in the fetched set — must never let the <select> fall back to ''
  // and NULL a valid reference on an untouched save. `withPreservedOption`
  // guarantees the currently-set id always has a matching <option>. See
  // lib/quotes/preserve-option.ts.
  const selectedCustomerId = pick("customer_id");
  const selectedAssignee = pick("assigned_to");
  const customerOptions = withPreservedOption(
    customers,
    selectedCustomerId,
    (id) => ({ id, name: "Current customer" }),
  );
  const staffOptions = withPreservedOption(
    staff,
    selectedAssignee,
    (id) => ({ id, full_name: "Current assignee", email: "" }),
  );

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

      <SelectField
        name="customer_id"
        label="Customer"
        defaultValue={selectedCustomerId}
        error={fe.customer_id}
        options={[
          {
            value: "",
            label: customers.length === 0 ? "— No customers yet —" : "— None —",
          },
          ...customerOptions.map((c) => ({ value: c.id, label: c.name })),
        ]}
        help={
          customers.length === 0
            ? "Add a customer first via the Customers tab."
            : undefined
        }
      />
      <SelectField
        name="assigned_to"
        label="Assigned to"
        defaultValue={selectedAssignee}
        error={fe.assigned_to}
        options={[
          { value: "", label: "— Unassigned —" },
          ...staffOptions.map((s) => ({
            value: s.id,
            label: s.full_name ?? s.email,
          })),
        ]}
      />
      <SelectField
        name="status"
        label="Status"
        required
        defaultValue={pick("status", "new")}
        error={fe.status}
        options={[
          { value: "new", label: "New" },
          { value: "in-progress", label: "In progress" },
          { value: "completed", label: "Completed" },
          { value: "blocked", label: "Blocked" },
        ]}
      />
      <Field
        name="scheduled_date"
        label="Scheduled date"
        type="date"
        optional
        defaultValue={pick("scheduled_date")}
        error={fe.scheduled_date}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SelectField
          name="recurring_pattern"
          label="Recurring"
          defaultValue={pick("recurring_pattern")}
          error={fe.recurring_pattern}
          options={[
            { value: "", label: "One-off" },
            { value: "weekly", label: "Weekly" },
            { value: "biweekly", label: "Every 2 weeks" },
            { value: "monthly", label: "Monthly" },
            { value: "quarterly", label: "Quarterly" },
          ]}
          help="Shows extra occurrences on the calendar from the scheduled date."
        />
        <Field
          name="recurring_end_date"
          label="Repeat until"
          type="date"
          optional
          defaultValue={pick("recurring_end_date")}
          error={fe.recurring_end_date}
        />
      </div>
      <fieldset className="space-y-4 rounded-lg border border-slate-200 p-4">
        <legend className="px-1 text-sm font-semibold text-slate-700">
          Site address (optional)
        </legend>
        <p className="text-xs text-slate-500">
          Leave blank to use the customer&apos;s address. Fill in only when the
          work is at a different site.
        </p>
        <Field
          name="site_address_line1"
          label="Address line 1"
          optional
          autoComplete="address-line1"
          defaultValue={pick("site_address_line1")}
          error={fe.site_address_line1}
        />
        <Field
          name="site_address_line2"
          label="Address line 2"
          optional
          autoComplete="address-line2"
          defaultValue={pick("site_address_line2")}
          error={fe.site_address_line2}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            name="site_city"
            label="City / Town"
            optional
            defaultValue={pick("site_city")}
            error={fe.site_city}
          />
          <Field
            name="site_county"
            label="County"
            optional
            defaultValue={pick("site_county")}
            error={fe.site_county}
          />
          <Field
            name="site_postcode"
            label="Postcode"
            optional
            defaultValue={pick("site_postcode")}
            error={fe.site_postcode}
          />
          <Field
            name="site_country"
            label="Country"
            optional
            defaultValue={pick("site_country")}
            error={fe.site_country}
          />
        </div>
      </fieldset>

      <TextareaField
        name="notes"
        label="Notes"
        optional
        rows={4}
        placeholder="Scope, materials, access notes…"
        defaultValue={pick("notes")}
        error={fe.notes}
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
