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

export function AddPaymentForm({
  action,
  defaultAmount,
}: {
  action: Action;
  defaultAmount: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_FORM_STATE as FormState<Record<string, unknown>>,
  );
  const router = useRouter();
  const todayIso = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    if (!state.ok) return;
    router.refresh();
  }, [state.ok, state.submittedAt, router]);

  const v = (state.values ?? {}) as Record<string, unknown>;
  const fe = state.fieldErrors ?? {};
  const pick = (k: string, fb = "") => {
    const x = v[k];
    return typeof x === "string" ? x : typeof x === "number" ? String(x) : fb;
  };

  return (
    <div className="mt-5 space-y-2">
      <FormErrorBanner error={state.error} />
      <FormSuccessBanner message={state.ok ? state.successMessage : null} />
      <form
        action={formAction}
        noValidate
        className="grid grid-cols-1 gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 sm:grid-cols-5"
      >
        <label className="block text-xs text-slate-600">
          Amount (£)
          <input
            type="number"
            name="amount"
            required
            min={0.01}
            step={0.01}
            defaultValue={pick("amount", defaultAmount)}
            aria-invalid={fe.amount ? true : undefined}
            className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-sm ${fe.amount ? "border-red-400" : "border-slate-300"}`}
          />
          {fe.amount ? (
            <p role="alert" className="mt-1 text-[11px] text-red-700">
              {fe.amount}
            </p>
          ) : null}
        </label>
        <label className="block text-xs text-slate-600">
          Paid on
          <input
            type="date"
            name="paid_at"
            required
            defaultValue={pick("paid_at", todayIso)}
            aria-invalid={fe.paid_at ? true : undefined}
            className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-sm ${fe.paid_at ? "border-red-400" : "border-slate-300"}`}
          />
          {fe.paid_at ? (
            <p role="alert" className="mt-1 text-[11px] text-red-700">
              {fe.paid_at}
            </p>
          ) : null}
        </label>
        <label className="block text-xs text-slate-600 sm:col-span-1">
          Reference
          <input
            type="text"
            name="reference"
            placeholder="bank ref / cheque #"
            defaultValue={pick("reference")}
            className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-sm ${fe.reference ? "border-red-400" : "border-slate-300"}`}
          />
          {fe.reference ? (
            <p role="alert" className="mt-1 text-[11px] text-red-700">
              {fe.reference}
            </p>
          ) : null}
        </label>
        <label className="block text-xs text-slate-600 sm:col-span-2">
          Notes
          <input
            type="text"
            name="notes"
            placeholder="e.g. transferred via Faster Payments"
            defaultValue={pick("notes")}
            className={`mt-1 block w-full rounded-md border px-2 py-1.5 text-sm ${fe.notes ? "border-red-400" : "border-slate-300"}`}
          />
          {fe.notes ? (
            <p role="alert" className="mt-1 text-[11px] text-red-700">
              {fe.notes}
            </p>
          ) : null}
        </label>
        <div className="sm:col-span-5">
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {pending ? "Recording…" : "Record payment"}
          </button>
          <p className="mt-1 text-[11px] text-slate-500">
            Status auto-updates: any amount &gt; 0 → partially_paid; total
            fully paid → paid. Adding multiple smaller payments is fine.
          </p>
        </div>
      </form>
    </div>
  );
}
