"use client";

import { useActionState, useEffect } from "react";
import { Field, SelectField, TextareaField } from "../_components/field";
import { FormErrorBanner } from "@/components/forms/Field";
import { SubmitButton } from "@/components/forms/FormShell";
import { SignaturePad } from "@/app/_components/signature-pad";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { recordInduction, signInVisitor, signOutVisitor } from "./actions";

/**
 * Site-compliance client forms. They dispatch FormState-returning server
 * actions and navigate with a FULL DOCUMENT LOAD on success (window.location.
 * assign) — the app-wide cure for the Next 15.5 deep-swap commit race that a
 * same-route `?saved=` router.push loses on [id] pages (see StateForm's header).
 * Field errors render inline from state.fieldErrors, which is why these use
 * useActionState directly rather than the plain <StateForm>.
 */

type CV = Record<string, unknown>;
type ActionFn = (prev: FormState<CV>, formData: FormData) => Promise<FormState<CV>>;

function useNavigatingAction(action: ActionFn) {
  const [state, formAction, pending] = useActionState<FormState<CV>, FormData>(
    action,
    INITIAL_FORM_STATE,
  );
  useEffect(() => {
    if (state.ok && state.redirectTo) window.location.assign(state.redirectTo);
  }, [state.ok, state.redirectTo, state.submittedAt]);
  return { state, formAction, pending };
}

export type WorkerOption = { id: string; full_name: string | null; email: string };

export function InductionForm({
  siteId,
  workers,
}: {
  siteId: string;
  workers: WorkerOption[];
}) {
  const { state, formAction, pending } = useNavigatingAction(recordInduction);
  const fe = state.fieldErrors ?? {};

  const workerOptions = [
    { value: "", label: "— External operative (enter below) —" },
    ...workers.map((w) => ({ value: w.id, label: w.full_name ?? w.email })),
  ];

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="siteId" value={siteId} />
      <FormErrorBanner error={state.error} />

      <SelectField
        name="userId"
        label="Worker (your team)"
        options={workerOptions}
        defaultValue={(state.values?.userId as string) ?? ""}
        help="Pick a team member, or leave as External and name the subcontractor operative below."
        error={fe.userId}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="personName"
          label="External operative name"
          optional
          defaultValue={(state.values?.personName as string) ?? ""}
          error={fe.personName}
          placeholder="e.g. Sam Doyle"
        />
        <Field
          name="personCompany"
          label="Their company"
          optional
          defaultValue={(state.values?.personCompany as string) ?? ""}
          error={fe.personCompany}
          placeholder="e.g. Doyle Groundworks Ltd"
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="inductionVersion"
          label="Induction version"
          required
          defaultValue={(state.values?.inductionVersion as string) ?? ""}
          error={fe.inductionVersion}
          placeholder="e.g. 2026-08 or v3"
          help="The site induction pack / briefing version in force."
        />
        <Field
          name="validUntil"
          label="Re-induct by"
          type="date"
          optional
          defaultValue={(state.values?.validUntil as string) ?? ""}
          error={fe.validUntil}
          help="Leave blank for no expiry."
        />
      </div>
      <Field
        name="signedName"
        label="Name signed"
        required
        defaultValue={(state.values?.signedName as string) ?? ""}
        error={fe.signedName}
        help="The name the operative signs as."
      />

      <div>
        <p className="text-sm font-medium text-slate-800">Signature (optional)</p>
        <p className="mb-1.5 mt-0.5 text-xs text-slate-500">
          Capture the operative&rsquo;s signature. The typed name above is recorded regardless.
        </p>
        <SignaturePad name="signatureDataUrl" />
      </div>

      <SubmitButton pending={pending}>Record induction</SubmitButton>
    </form>
  );
}

export function VisitorSignInForm({
  siteId,
  hosts,
}: {
  siteId: string;
  hosts: WorkerOption[];
}) {
  const { state, formAction, pending } = useNavigatingAction(signInVisitor);
  const fe = state.fieldErrors ?? {};

  const hostOptions = [
    { value: "", label: "— No host —" },
    ...hosts.map((w) => ({ value: w.id, label: w.full_name ?? w.email })),
  ];

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <input type="hidden" name="siteId" value={siteId} />
      <FormErrorBanner error={state.error} />

      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          name="visitorName"
          label="Visitor name"
          required
          defaultValue={(state.values?.visitorName as string) ?? ""}
          error={fe.visitorName}
        />
        <Field
          name="company"
          label="Company"
          optional
          defaultValue={(state.values?.company as string) ?? ""}
          error={fe.company}
        />
      </div>
      <TextareaField
        name="purpose"
        label="Purpose of visit"
        rows={2}
        optional
        defaultValue={(state.values?.purpose as string) ?? ""}
        error={fe.purpose}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          name="hostUserId"
          label="Host"
          options={hostOptions}
          defaultValue={(state.values?.hostUserId as string) ?? ""}
          error={fe.hostUserId}
        />
        <Field
          name="vehicleRegistration"
          label="Vehicle reg"
          optional
          defaultValue={(state.values?.vehicleRegistration as string) ?? ""}
          error={fe.vehicleRegistration}
        />
      </div>

      <SubmitButton pending={pending}>Sign visitor in</SubmitButton>
    </form>
  );
}

/** Sign a visitor out. Navigates via window.location.assign on success. */
export function SignOutButton({ siteId, visitorId }: { siteId: string; visitorId: string }) {
  const { formAction, pending } = useNavigatingAction(signOutVisitor);
  return (
    <form action={formAction}>
      <input type="hidden" name="siteId" value={siteId} />
      <input type="hidden" name="visitorId" value={visitorId} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex min-h-[36px] items-center rounded-md border border-slate-300 px-3 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60"
      >
        {pending ? "…" : "Sign out"}
      </button>
    </form>
  );
}
