"use client";

import Link from "next/link";
import { useActionState, useEffect } from "react";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { FormErrorBanner, FormSuccessBanner } from "@/components/forms/Field";

type ApproveAction = (
  prevState: FormState<Record<string, unknown>>,
  formData: FormData,
) => Promise<FormState<Record<string, unknown>>>;

/**
 * Approve & save the generated rota.
 *
 * The button is the ONLY write on this page. It carries no assignment data — the
 * server re-derives the plan from the org's own records, so the browser cannot
 * inject a row. On a clean save the action returns `redirectTo` and we navigate
 * with `window.location.assign` (NOT router.push): /staff/rota/generate sits at
 * route-swap depth ≥4, where Next 15.5 silently drops a router navigation.
 *
 * When some assignments were skipped (already saved, or clashing) the action
 * returns no redirect and we show exactly what happened, with a link to the rota.
 */
export function ApproveRotaForm({
  action,
  count,
}: {
  action: ApproveAction;
  count: number;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_FORM_STATE as FormState<Record<string, unknown>>,
  );

  useEffect(() => {
    if (state.ok && state.redirectTo) window.location.assign(state.redirectTo);
  }, [state.ok, state.redirectTo, state.submittedAt]);

  const done = state.ok && !state.redirectTo;

  return (
    <div className="space-y-2">
      <FormErrorBanner error={state.error} />
      {state.ok ? <FormSuccessBanner message={state.successMessage ?? null} /> : null}
      <form action={formAction} className="flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex min-h-[40px] items-center justify-center rounded-md bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {pending
            ? "Saving…"
            : `Approve & save ${count} ${count === 1 ? "assignment" : "assignments"}`}
        </button>
        {done ? (
          <Link
            href="/staff/rota"
            className="text-sm font-medium text-slate-700 underline hover:text-slate-900"
          >
            View the rota →
          </Link>
        ) : null}
      </form>
      <p className="text-[11px] leading-relaxed text-slate-500">
        Saving writes these shifts to the rota in one go — all of them or none.
        Shifts already on the rota are left as they are, and anything that clashes
        with a confirmed shift is left untouched and explained, never overwritten.
      </p>
    </div>
  );
}
