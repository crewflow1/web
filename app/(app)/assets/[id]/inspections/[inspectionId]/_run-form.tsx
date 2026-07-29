"use client";

import { useActionState, useEffect } from "react";
import { INITIAL_FORM_STATE, isPristine, type FormState } from "@/lib/forms/state";
import { FormErrorBanner } from "@/components/forms/Field";

/**
 * Client shell for the inspection run form — ONE form, TWO server actions
 * (Complete = the form's action, Save progress = the secondary button's
 * formAction). Both return FormState; whichever ran most recently drives the
 * banner and the success navigation.
 *
 * WHY (do not swap back to `<form action={serverAction}>` + `redirect()`):
 * this page sits at the deepest route swap in the app
 * (/assets/[id]/inspections/[inspectionId] → itself with ?saved=), where a
 * Server-Action redirect() loses the Next 15.5 stranded-commit race
 * (vercel/next.js#83386) — the answers are written but the browser never
 * moves, silently. Success therefore navigates with a full document load via
 * window.location.assign. See components/forms/StateForm.tsx (single-action
 * variant) and the fleet fix (8e4a846).
 *
 * The checklist sections stay server-rendered as children; only the form
 * boundary, the two dispatches, the banner and the buttons live here.
 */
export function InspectionRunForm({
  completeAction,
  saveAction,
  running,
  className,
  children,
}: {
  completeAction: (prev: FormState, formData: FormData) => Promise<FormState>;
  saveAction: (prev: FormState, formData: FormData) => Promise<FormState>;
  running: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [completeState, completeDispatch] = useActionState(completeAction, INITIAL_FORM_STATE);
  const [saveState, saveDispatch] = useActionState(saveAction, INITIAL_FORM_STATE);

  // Whichever action ran last owns the outcome (submittedAt stamps each run).
  const latest =
    (saveState.submittedAt ?? 0) > (completeState.submittedAt ?? 0) ? saveState : completeState;

  useEffect(() => {
    if (latest.ok && latest.redirectTo) window.location.assign(latest.redirectTo);
  }, [latest.ok, latest.redirectTo, latest.submittedAt]);

  return (
    <form action={completeDispatch} className={className}>
      {!isPristine(latest) && latest.error ? <FormErrorBanner error={latest.error} /> : null}
      {children}
      {running ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            className="rounded-md bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white hover:bg-slate-800"
          >
            Complete inspection
          </button>
          <button
            type="submit"
            formAction={saveDispatch}
            className="rounded-md border border-slate-300 px-5 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Save progress
          </button>
          <span className="text-xs text-slate-500">
            Completing derives the outcome from your answers and locks the record.
          </span>
        </div>
      ) : null}
    </form>
  );
}
