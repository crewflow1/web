"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";

type Values = Record<string, unknown>;
type Action = (
  prevState: FormState<Values>,
  formData: FormData,
) => Promise<FormState<Values>>;

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

/**
 * Inline overtime editor for one DRAFT payroll line. Posts hours + multiplier to
 * `setPayrollLineOvertime` (server-side: admin-only, draft-only, audited, recomputes
 * gross/PAYE/NI/net). Refreshes the run page on success so the recomputed figures show.
 */
export function OvertimeForm({
  action,
  defaults,
  overtimePay,
}: {
  action: Action;
  defaults: { overtime_hours: string; overtime_multiplier: string };
  overtimePay: number;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_FORM_STATE as FormState<Values>,
  );
  const router = useRouter();
  useEffect(() => {
    if (state.ok) router.refresh();
  }, [state.ok, state.submittedAt, router]);

  return (
    <form action={formAction} className="flex items-center justify-end gap-1">
      <label className="sr-only" htmlFor="overtime_hours">
        Overtime hours
      </label>
      <input
        id="overtime_hours"
        type="number"
        name="overtime_hours"
        step={0.25}
        min={0}
        defaultValue={defaults.overtime_hours}
        onFocus={(e) => e.currentTarget.select()}
        className="w-16 rounded-md border border-slate-300 px-1.5 py-1 text-right text-xs"
        title="Overtime hours"
      />
      <span className="text-[11px] text-slate-400">×</span>
      <label className="sr-only" htmlFor="overtime_multiplier">
        Overtime multiplier
      </label>
      <input
        id="overtime_multiplier"
        type="number"
        name="overtime_multiplier"
        step={0.1}
        min={0}
        defaultValue={defaults.overtime_multiplier}
        onFocus={(e) => e.currentTarget.select()}
        className="w-14 rounded-md border border-slate-300 px-1.5 py-1 text-right text-xs"
        title="Overtime multiplier (e.g. 1.5)"
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {pending ? "…" : "Save"}
      </button>
      {overtimePay > 0 ? (
        <span className="ml-1 text-[11px] text-slate-500">
          {GBP.format(overtimePay)}
        </span>
      ) : null}
      {state.error ? (
        <span role="alert" className="ml-1 text-[11px] text-red-600">
          {state.error}
        </span>
      ) : null}
    </form>
  );
}
