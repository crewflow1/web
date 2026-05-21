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

type Action = (
  prevState: FormState<Record<string, unknown>>,
  formData: FormData,
) => Promise<FormState<Record<string, unknown>>>;

export function CreateRunForm({
  title,
  cycle,
  defaultStart,
  defaultEnd,
  action,
}: {
  title: string;
  cycle: "weekly" | "monthly";
  defaultStart: string;
  defaultEnd: string;
  action: Action;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_FORM_STATE as FormState<Record<string, unknown>>,
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
  const pick = (k: string, fb: string) => {
    const x = v[k];
    return typeof x === "string" && x.length > 0 ? x : fb;
  };

  return (
    <form
      action={formAction}
      noValidate
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
      <div className="mt-2 space-y-2">
        <FormErrorBanner error={state.error} />
        <FormSuccessBanner message={state.ok ? state.successMessage : null} />
      </div>
      <input type="hidden" name="cycle" value={cycle} />
      <div className="mt-3 grid grid-cols-2 gap-2">
        <label className="block text-xs text-slate-600">
          Period start
          <input
            type="date"
            name="period_start"
            defaultValue={pick("period_start", defaultStart)}
            aria-invalid={fe.period_start ? true : undefined}
            className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-sm ${fe.period_start ? "border-red-400" : "border-slate-300"}`}
            required
          />
          {fe.period_start ? (
            <p role="alert" className="mt-1 text-[11px] text-red-700">
              {fe.period_start}
            </p>
          ) : null}
        </label>
        <label className="block text-xs text-slate-600">
          Period end
          <input
            type="date"
            name="period_end"
            defaultValue={pick("period_end", defaultEnd)}
            aria-invalid={fe.period_end ? true : undefined}
            className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-sm ${fe.period_end ? "border-red-400" : "border-slate-300"}`}
            required
          />
          {fe.period_end ? (
            <p role="alert" className="mt-1 text-[11px] text-red-700">
              {fe.period_end}
            </p>
          ) : null}
        </label>
      </div>
      <button
        type="submit"
        disabled={pending}
        className="mt-3 w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
      >
        {pending ? "Generating…" : "Generate draft run"}
      </button>
      <p className="mt-1 text-[11px] text-slate-500">
        Pulls completed time entries in the window. Edit lines before finalising.
      </p>
    </form>
  );
}
