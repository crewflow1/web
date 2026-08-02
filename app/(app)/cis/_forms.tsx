"use client";

import { useActionState } from "react";

import { FormShell, SubmitButton } from "@/components/forms/FormShell";
import { Field } from "../_components/field";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";

type Values = Record<string, unknown>;
type ActionFn = (prev: FormState<Values>, formData: FormData) => Promise<FormState<Values>>;

/**
 * H2-CIS M4 client forms.
 *
 * NOTE THE LANGUAGE THROUGHOUT. No button in this file says "file", "submit to
 * HMRC" or "send". CrewFlow prepares figures and issues documents; it has no
 * HMRC integration, and the labels must never let a user believe otherwise.
 */

// ---------------------------------------------------------------------------
// The contractor's own CIS identity
// ---------------------------------------------------------------------------

export function ContractorProfileForm({
  action,
  defaults,
}: {
  action: ActionFn;
  defaults: {
    legal_name: string;
    employer_paye_reference: string;
    accounts_office_reference: string;
    contractor_utr: string;
  };
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);
  const v = (state.values ?? {}) as Record<string, string>;

  return (
    <FormShell state={state} action={formAction}>
      <div>
        <h2 className="text-lg font-semibold text-slate-900">Your CIS contractor details</h2>
        <p className="mt-1 text-sm text-slate-600">
          HMRC requires your business name and employer PAYE reference on every payment and
          deduction statement you give a subcontractor. Statements cannot be issued until these
          are on file.
        </p>
      </div>

      <Field
        name="legal_name"
        label="Business name as HMRC holds it"
        required
        defaultValue={v.legal_name ?? defaults.legal_name}
        error={state.fieldErrors?.legal_name}
        help="Often different from your trading name."
      />
      <Field
        name="employer_paye_reference"
        label="Employer PAYE reference"
        required
        placeholder="123/AB45678"
        defaultValue={v.employer_paye_reference ?? defaults.employer_paye_reference}
        error={state.fieldErrors?.employer_paye_reference}
        help="Three digits, a slash, then your reference. On any P30 or your PAYE letters."
      />
      <Field
        name="accounts_office_reference"
        label="Accounts Office reference"
        optional
        placeholder="123PX00123456"
        defaultValue={v.accounts_office_reference ?? defaults.accounts_office_reference}
        error={state.fieldErrors?.accounts_office_reference}
        help="Used when you pay deductions over to HMRC. Not shown on statements."
      />
      <Field
        name="contractor_utr"
        label="Your UTR"
        optional
        placeholder="1234567890"
        defaultValue={v.contractor_utr ?? defaults.contractor_utr}
        error={state.fieldErrors?.contractor_utr}
        help="Ten digits. Kept with your filing details."
      />

      <SubmitButton pending={pending}>Save contractor details</SubmitButton>
    </FormShell>
  );
}

// ---------------------------------------------------------------------------
// Issue / reissue a statement
// ---------------------------------------------------------------------------

export function IssueStatementButton({
  action,
  supplierId,
  taxMonthEnd,
  label,
  disabled,
  disabledReason,
}: {
  action: ActionFn;
  supplierId: string;
  taxMonthEnd: string;
  label: string;
  disabled?: boolean;
  disabledReason?: string | null;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);

  return (
    <form action={formAction} className="inline-flex flex-col items-start gap-1">
      <input type="hidden" name="supplier_id" value={supplierId} />
      <input type="hidden" name="tax_month_end" value={taxMonthEnd} />
      <button
        type="submit"
        disabled={pending || disabled}
        className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {pending ? "Issuing…" : label}
      </button>
      {disabled && disabledReason ? (
        <span className="text-xs text-slate-500">{disabledReason}</span>
      ) : null}
      {state.error ? (
        <span role="alert" className="text-xs text-red-700">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Withdraw a statement
// ---------------------------------------------------------------------------

export function WithdrawStatementForm({
  action,
  statementId,
}: {
  action: ActionFn;
  statementId: string;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);

  return (
    <FormShell state={state} action={formAction} className="space-y-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <input type="hidden" name="statement_id" value={statementId} />
      <div>
        <h3 className="text-sm font-semibold text-amber-900">Withdraw this statement</h3>
        <p className="mt-1 text-sm text-amber-900">
          Use this when every payment it covered has been voided, so there is nothing left to
          restate. The statement is kept as a record and marked withdrawn — it is never deleted,
          because the subcontractor holds a copy.
        </p>
      </div>
      <Field
        name="reason"
        label="Why is it being withdrawn?"
        required
        defaultValue=""
        error={state.fieldErrors?.reason}
      />
      <SubmitButton pending={pending}>Withdraw statement</SubmitButton>
    </FormShell>
  );
}

// ---------------------------------------------------------------------------
// Prepare / export the monthly return dataset
// ---------------------------------------------------------------------------

export function PrepareReturnButton({
  action,
  taxMonthEnd,
  label,
}: {
  action: ActionFn;
  taxMonthEnd: string;
  label: string;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);

  return (
    <form action={formAction} className="inline-flex flex-col items-start gap-1">
      <input type="hidden" name="tax_month_end" value={taxMonthEnd} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Preparing…" : label}
      </button>
      {state.error ? (
        <span role="alert" className="text-xs text-red-700">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}

/**
 * Email the month's issued, statutory statements to their subcontractors.
 *
 * "Email", never "file" or "send to HMRC": this delivers the document the
 * subcontractor is owed, and nothing here reaches HMRC. Idempotent, so a second
 * click over an unchanged month queues nothing new.
 */
export function EmailStatementsButton({
  action,
  taxMonthEnd,
}: {
  action: ActionFn;
  taxMonthEnd: string;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);

  return (
    <form action={formAction} className="inline-flex flex-col items-start gap-1">
      <input type="hidden" name="tax_month_end" value={taxMonthEnd} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Queuing…" : "Email statements to subcontractors"}
      </button>
      <span className="text-xs text-slate-500">
        Sends each subcontractor their own statement. It does not file anything with HMRC.
      </span>
      {state.error ? (
        <span role="alert" className="text-xs text-red-700">
          {state.error}
        </span>
      ) : null}
      {state.successMessage ? (
        <span className="text-xs text-emerald-700">{state.successMessage}</span>
      ) : null}
    </form>
  );
}

export function MarkExportedButton({
  action,
  returnId,
}: {
  action: ActionFn;
  returnId: string;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);

  return (
    <form action={formAction} className="inline-flex flex-col items-start gap-1">
      <input type="hidden" name="return_id" value={returnId} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-900 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Saving…" : "Mark as exported"}
      </button>
      <span className="text-xs text-slate-500">
        Records that you downloaded these figures. It does not file anything.
      </span>
      {state.error ? (
        <span role="alert" className="text-xs text-red-700">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
