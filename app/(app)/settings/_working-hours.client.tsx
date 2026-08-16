"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import {
  FormErrorBanner,
  FormSuccessBanner,
} from "@/components/forms/Field";
import { SubmitButton } from "@/components/forms/FormShell";
import { WEEKDAYS, WEEKDAY_LABEL, type WorkingHours } from "@/lib/org-config/schema";

type Action = (
  prev: FormState,
  formData: FormData,
) => Promise<FormState>;

/**
 * Working-hours editor — a self-contained client form. One row per weekday: an
 * "open" checkbox that enables/greys the open→close time pair. Submits the whole
 * week in one go via `useActionState`. Per-day validation errors come back keyed
 * by weekday in `state.fieldErrors`.
 *
 * Disabled wholesale for non-admins (fieldset disabled) — the DB + action still
 * enforce admin-write, this is just the honest UI.
 */
export function WorkingHoursForm({
  workingHours,
  isAdmin,
  action,
}: {
  workingHours: WorkingHours;
  isAdmin: boolean;
  action: Action;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);
  const router = useRouter();
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, state.submittedAt, router]);

  const fe = state.fieldErrors ?? {};

  return (
    <form action={formAction} noValidate className="mt-5 space-y-4">
      <FormErrorBanner error={state.error} />
      <FormSuccessBanner message={state.ok ? state.successMessage : null} />

      <fieldset disabled={!isAdmin} className="space-y-2 disabled:opacity-60">
        {WEEKDAYS.map((day) => {
          const hours = workingHours[day];
          const open = hours?.open ?? "08:00";
          const close = hours?.close ?? "17:00";
          const working = hours !== null;
          return (
            <div key={day}>
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-slate-200 px-3 py-2.5">
                <label className="flex w-32 shrink-0 items-center gap-2 text-sm font-medium text-slate-800">
                  <input
                    type="checkbox"
                    name={`open_${day}`}
                    defaultChecked={working}
                    className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
                    aria-label={`${WEEKDAY_LABEL[day]} is a working day`}
                  />
                  {WEEKDAY_LABEL[day]}
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="time"
                    name={`${day}_open`}
                    defaultValue={open}
                    aria-label={`${WEEKDAY_LABEL[day]} opening time`}
                    className="rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                  />
                  <span className="text-sm text-slate-500">to</span>
                  <input
                    type="time"
                    name={`${day}_close`}
                    defaultValue={close}
                    aria-label={`${WEEKDAY_LABEL[day]} closing time`}
                    className="rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                  />
                </div>
              </div>
              {fe[day] ? (
                <p role="alert" className="mt-1 text-xs text-red-700">
                  {fe[day]}
                </p>
              ) : null}
            </div>
          );
        })}
      </fieldset>

      <p className="text-xs text-slate-500">
        Untick a day to mark it non-working. Other CrewFlow features read these
        hours as the default working window when scheduling.
      </p>

      {isAdmin ? (
        <SubmitButton pending={pending}>Save working hours</SubmitButton>
      ) : null}
    </form>
  );
}
