"use client";

import Link from "next/link";
import { useActionState } from "react";

import { FormShell, SubmitButton } from "@/components/forms/FormShell";
import { Field, SelectField, TextareaField } from "../../../_components/field";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import {
  CIS_OUTCOME_STATUSES,
  CIS_STATUS_LABELS,
  SUBCONTRACTOR_TYPES,
  SUBCONTRACTOR_TYPE_LABELS,
  type CisStatus,
} from "@/lib/cis/types";
import { canRecordVerificationOutcome } from "@/lib/cis/verification";

type Values = Record<string, unknown>;
type ActionFn = (prev: FormState<Values>, formData: FormData) => Promise<FormState<Values>>;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The identity half of a CIS profile.
 *
 * THE UTR FIELD IS WRITE-ONLY BY DESIGN. When one is already stored the input
 * renders EMPTY with the masked value shown beside it as a label, so the admin
 * can confirm they are looking at the right record without the full number ever
 * being sent to the browser. Leaving it blank keeps the stored value; typing a
 * new one replaces it. Same treatment `staff_secrets` gives an NI number.
 */
export function CisProfileForm({
  action,
  defaults,
  maskedUtr,
  hasUtr,
}: {
  action: ActionFn;
  defaults: {
    legal_name: string;
    trading_name: string;
    company_number: string;
    subcontractor_type: string;
    vat_registered: boolean;
    vat_number: string;
    notes: string;
  };
  maskedUtr: string;
  hasUtr: boolean;
}) {
  const [state, formAction, pending] = useActionState<FormState<Values>, FormData>(
    action,
    INITIAL_FORM_STATE,
  );
  const errors = state.fieldErrors ?? {};

  return (
    <FormShell state={state} action={formAction}>
      <Field
        name="legal_name"
        label="Legal name (as HMRC holds it)"
        required
        defaultValue={defaults.legal_name}
        error={errors.legal_name}
        help="The name on their CIS record — often not the trading name."
      />
      <Field
        name="trading_name"
        label="Trading name"
        optional
        defaultValue={defaults.trading_name}
        error={errors.trading_name}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="subcontractor_type"
          label="Legal form"
          defaultValue={defaults.subcontractor_type}
          error={errors.subcontractor_type}
          options={[
            { value: "", label: "Not set" },
            ...SUBCONTRACTOR_TYPES.map((t) => ({
              value: t,
              label: SUBCONTRACTOR_TYPE_LABELS[t],
            })),
          ]}
        />
        <Field
          name="company_number"
          label="Company number"
          optional
          inputMode="numeric"
          placeholder="12345678"
          defaultValue={defaults.company_number}
          error={errors.company_number}
        />
      </div>

      <div>
        <Field
          name="utr"
          label="UTR (Unique Taxpayer Reference)"
          optional={hasUtr}
          required={false}
          inputMode="numeric"
          autoComplete="off"
          placeholder={hasUtr ? "Leave blank to keep the stored UTR" : "1234567890"}
          error={errors.utr}
          help={
            hasUtr
              ? `Currently stored: ${maskedUtr}. Type a new one only if it has changed.`
              : "10 digits. Stored where only owners and admins can read it."
          }
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex items-center">
          <label className="flex min-h-[44px] items-center gap-2 text-sm font-medium text-slate-800">
            <input
              type="checkbox"
              name="vat_registered"
              defaultChecked={defaults.vat_registered}
              className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
            />
            VAT registered
          </label>
        </div>
        <Field
          name="vat_number"
          label="VAT number"
          optional
          placeholder="GB123456789"
          defaultValue={defaults.vat_number}
          error={errors.vat_number}
        />
      </div>

      <TextareaField
        name="notes"
        label="Notes"
        rows={3}
        optional
        defaultValue={defaults.notes}
        error={errors.notes}
      />

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <SubmitButton pending={pending}>Save CIS details</SubmitButton>
        <Link
          href="/suppliers"
          className="text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Back to suppliers
        </Link>
      </div>
    </FormShell>
  );
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Record a verification an admin obtained from HMRC THEMSELVES. The "Verify
 * with HMRC" button is a SEPARATE component (CisHmrcVerifyForm below) that the
 * page renders only when HMRC is actually connectable — presenting it while
 * dark would imply a check this system cannot perform.
 *
 * The deduction rate is NOT an input. It is derived from the result and shown
 * in the option labels, so a 30% result cannot be filed as a 20% one.
 */
export function CisVerificationForm({
  action,
  currentStatus,
  defaultDate,
  hasUtr,
}: {
  action: ActionFn;
  currentStatus: CisStatus;
  defaultDate: string;
  hasUtr: boolean;
}) {
  const [state, formAction, pending] = useActionState<FormState<Values>, FormData>(
    action,
    INITIAL_FORM_STATE,
  );
  const errors = state.fieldErrors ?? {};

  // All four HMRC outcomes are offered, including the current one: re-verifying
  // to the same result is the commonest case and must be recordable. The current
  // status is preselected because "unchanged" is the likeliest answer.
  const options = CIS_OUTCOME_STATUSES.filter((s) =>
    canRecordVerificationOutcome(currentStatus, s),
  );

  if (!hasUtr) {
    return (
      <p className="text-sm text-slate-600">
        Record the subcontractor&apos;s UTR above before recording a verification — HMRC
        can&apos;t verify anyone without one.
      </p>
    );
  }

  if (options.length === 0) {
    return (
      <p className="text-sm text-slate-600">
        No verification result can be recorded from the current status.
      </p>
    );
  }

  return (
    <FormShell state={state} action={formAction} className="space-y-5">
      <SelectField
        name="cis_status"
        label="Result HMRC gave you"
        required
        defaultValue={options.includes(currentStatus as never) ? currentStatus : undefined}
        error={errors.cis_status}
        options={options.map((s) => ({ value: s, label: CIS_STATUS_LABELS[s] }))}
        help="The deduction rate follows from the result — it can't be set separately."
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="verified_at"
          label="Date verified"
          type="date"
          required
          defaultValue={defaultDate}
          error={errors.verified_at}
        />
        <Field
          name="verification_expires_at"
          label="Expires"
          type="date"
          optional
          error={errors.verification_expires_at}
          help="Leave blank to use HMRC's rule (this tax year plus two)."
        />
      </div>
      <Field
        name="verification_reference"
        label="HMRC verification reference"
        optional
        placeholder="V1234567890"
        autoComplete="off"
        error={errors.verification_reference}
      />
      <div className="pt-1">
        <SubmitButton pending={pending}>Record verification</SubmitButton>
      </div>
    </FormShell>
  );
}

// ---------------------------------------------------------------------------
// HMRC online verification (rendered ONLY when HMRC is connectable)
// ---------------------------------------------------------------------------

/**
 * One button, no inputs: the identifiers HMRC needs are the stored profile and
 * the org's own contractor details, never anything typed here. The page only
 * renders this when `isHmrcConnectable()` is true (never in production today),
 * so its existence on screen is itself an honest signal — and the server
 * action re-checks connectability and admin role regardless, because a POST
 * can be replayed no matter what the UI showed.
 */
export function CisHmrcVerifyForm({
  action,
  hasUtr,
}: {
  action: ActionFn;
  hasUtr: boolean;
}) {
  const [state, formAction, pending] = useActionState<FormState<Values>, FormData>(
    action,
    INITIAL_FORM_STATE,
  );

  if (!hasUtr) {
    return (
      <p className="text-sm text-slate-600">
        Record the subcontractor&apos;s UTR below before verifying — HMRC can&apos;t verify
        anyone without one.
      </p>
    );
  }

  return (
    <FormShell state={state} action={formAction} className="space-y-2">
      <p className="text-xs text-slate-500">
        Asks HMRC&apos;s CIS verification service for this subcontractor&apos;s current
        status and records the answer — the deduction rate follows from HMRC&apos;s
        result and can&apos;t be chosen.
      </p>
      <SubmitButton pending={pending}>Verify with HMRC</SubmitButton>
    </FormShell>
  );
}

// ---------------------------------------------------------------------------
// Re-verification
// ---------------------------------------------------------------------------

export function CisReverificationForm({ action }: { action: ActionFn }) {
  const [state, formAction, pending] = useActionState<FormState<Values>, FormData>(
    action,
    INITIAL_FORM_STATE,
  );
  const errors = state.fieldErrors ?? {};

  return (
    <FormShell
      state={state}
      action={formAction}
      className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/60 p-4"
    >
      <p className="text-sm font-medium text-amber-900">Flag for re-verification</p>
      <p className="text-xs text-amber-800">
        Clears the deduction rate until HMRC confirms a new one. The previous result stays
        on record.
      </p>
      <Field
        name="reason"
        label="Reason"
        optional
        placeholder="e.g. Details changed, verification expired"
        error={errors.reason}
      />
      <SubmitButton
        pending={pending}
        className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md border border-amber-300 bg-white px-4 py-2.5 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-60 sm:w-auto"
      >
        Flag for re-verification
      </SubmitButton>
    </FormShell>
  );
}
