"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  INITIAL_FORM_STATE,
  type FormState,
} from "@/lib/forms/state";
import {
  FormErrorBanner,
  FormSuccessBanner,
} from "@/components/forms/Field";
import { LEAVE_TYPES } from "@/lib/staff/schema";

type LeaveAction = (
  prevState: FormState<Record<string, unknown>>,
  formData: FormData,
) => Promise<FormState<Record<string, unknown>>>;

const TYPE_LABEL: Record<string, string> = {
  holiday: "Holiday",
  sick: "Sick",
  emergency: "Emergency",
  unpaid: "Unpaid",
};

export function CreateLeaveForm({ action }: { action: LeaveAction }) {
  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_FORM_STATE as FormState<Record<string, unknown>>,
  );
  const router = useRouter();

  useEffect(() => {
    if (!state.ok) return;
    router.refresh();
  }, [state.ok, state.submittedAt, router]);

  const v = (state.values ?? {}) as Record<string, unknown>;
  const fe = state.fieldErrors ?? {};
  const pick = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : "");

  return (
    <>
      <div className="space-y-2">
        <FormErrorBanner error={state.error} />
        <FormSuccessBanner message={state.ok ? state.successMessage : null} />
      </div>
      <form
        action={formAction}
        noValidate
        className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-5 sm:items-end"
      >
        <label className="block text-xs text-slate-600">
          Type
          <select
            name="type"
            required
            defaultValue={pick("type")}
            aria-invalid={fe.type ? true : undefined}
            className={`mt-1 block w-full rounded-md border bg-white px-2 py-1.5 text-sm ${fe.type ? "border-red-400" : "border-slate-300"}`}
          >
            {LEAVE_TYPES.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
          {fe.type ? (
            <p role="alert" className="mt-1 text-[11px] text-red-700">
              {fe.type}
            </p>
          ) : null}
        </label>
        <label className="block text-xs text-slate-600">
          From
          <input
            type="date"
            name="starts_at"
            required
            defaultValue={pick("starts_at")}
            aria-invalid={fe.starts_at ? true : undefined}
            className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-sm ${fe.starts_at ? "border-red-400" : "border-slate-300"}`}
          />
          {fe.starts_at ? (
            <p role="alert" className="mt-1 text-[11px] text-red-700">
              {fe.starts_at}
            </p>
          ) : null}
        </label>
        <label className="block text-xs text-slate-600">
          To
          <input
            type="date"
            name="ends_at"
            required
            defaultValue={pick("ends_at")}
            aria-invalid={fe.ends_at ? true : undefined}
            className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-sm ${fe.ends_at ? "border-red-400" : "border-slate-300"}`}
          />
          {fe.ends_at ? (
            <p role="alert" className="mt-1 text-[11px] text-red-700">
              {fe.ends_at}
            </p>
          ) : null}
        </label>
        <label className="block text-xs text-slate-600 sm:col-span-2">
          Reason (optional)
          <input
            type="text"
            name="reason"
            defaultValue={pick("reason")}
            placeholder="e.g. annual holiday"
            className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-sm ${fe.reason ? "border-red-400" : "border-slate-300"}`}
          />
          {fe.reason ? (
            <p role="alert" className="mt-1 text-[11px] text-red-700">
              {fe.reason}
            </p>
          ) : null}
        </label>
        <div className="sm:col-span-5">
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {pending ? "Submitting…" : "Submit request"}
          </button>
        </div>
      </form>
    </>
  );
}
