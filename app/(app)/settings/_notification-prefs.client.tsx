"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import {
  FormErrorBanner,
  FormSuccessBanner,
} from "@/components/forms/Field";
import { SubmitButton } from "@/components/forms/FormShell";
import {
  NOTIFICATION_CADENCE_LABEL,
  type NotificationCadence,
} from "@/lib/notifications/preferences";

/** One editable row's resolved state, computed server-side. */
export type PrefRowView = {
  category: string;
  label: string;
  /** Critical categories are locked: always delivered, not user-editable. */
  critical: boolean;
  inApp: boolean;
  /** "off" | "immediate" | "daily" | "weekly" */
  emailChoice: "off" | NotificationCadence;
};

type Action = (prev: FormState, formData: FormData) => Promise<FormState>;

const EMAIL_OPTIONS: Array<{ value: "off" | NotificationCadence; label: string }> =
  [
    { value: "off", label: "Off" },
    { value: "immediate", label: NOTIFICATION_CADENCE_LABEL.immediate },
    { value: "daily", label: NOTIFICATION_CADENCE_LABEL.daily },
    { value: "weekly", label: NOTIFICATION_CADENCE_LABEL.weekly },
  ];

/**
 * Notification preferences grid — a self-contained client form. Renders one row
 * per notification category with an in-app toggle and an email cadence select.
 * Critical rows are shown but locked ("Always on") so the user understands they
 * can't be muted. Saves the whole grid in one submit via `useActionState`.
 */
export function NotificationPrefsForm({
  rows,
  action,
}: {
  rows: PrefRowView[];
  action: Action;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_FORM_STATE,
  );
  const router = useRouter();
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, state.submittedAt, router]);

  return (
    <form action={formAction} className="mt-5 space-y-4">
      <FormErrorBanner error={state.error} />
      <FormSuccessBanner message={state.ok ? state.successMessage : null} />

      <div className="overflow-x-auto">
        <table className="w-full min-w-[28rem] text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <th className="py-2 pr-4">Category</th>
              <th className="py-2 pr-4 text-center">In-app</th>
              <th className="py-2">Email</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr key={row.category}>
                <td className="py-3 pr-4">
                  <span className="font-medium text-slate-900">{row.label}</span>
                  {row.critical ? (
                    <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                      Always on
                    </span>
                  ) : null}
                </td>
                <td className="py-3 pr-4 text-center">
                  {row.critical ? (
                    <span className="text-xs text-slate-400">Required</span>
                  ) : (
                    <input
                      type="checkbox"
                      name={`inapp_${row.category}`}
                      defaultChecked={row.inApp}
                      aria-label={`In-app notifications for ${row.label}`}
                      className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
                    />
                  )}
                </td>
                <td className="py-3">
                  {row.critical ? (
                    <span className="text-xs text-slate-500">As it happens</span>
                  ) : (
                    <select
                      name={`email_${row.category}`}
                      defaultValue={row.emailChoice}
                      aria-label={`Email delivery for ${row.label}`}
                      className="rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                    >
                      {EMAIL_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-500">
        Critical alerts (payments and security) are always delivered and can&apos;t
        be turned off. Digest emails are sent daily or weekly, batching everything
        into one message.
      </p>

      <SubmitButton pending={pending}>Save preferences</SubmitButton>
    </form>
  );
}
