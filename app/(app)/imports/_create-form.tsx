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

export function CreateImportForm({ action }: { action: Action }) {
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
  const nameEcho = typeof v.name === "string" ? v.name : "";

  return (
    <>
      <div className="mt-3 space-y-2">
        <FormErrorBanner error={state.error} />
        <FormSuccessBanner message={state.ok ? state.successMessage : null} />
      </div>
      <form
        action={formAction}
        noValidate
        className="mt-4 flex flex-wrap items-end gap-2"
      >
        <label className="flex-1 text-xs text-slate-600">
          Session name
          <input
            type="text"
            name="name"
            defaultValue={nameEcho}
            placeholder="e.g. Sage exports — Jan 2026"
            className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
        >
          {pending ? "Creating…" : "New import"}
        </button>
      </form>
    </>
  );
}
