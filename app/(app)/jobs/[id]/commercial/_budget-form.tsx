"use client";

import { useActionState, useEffect, useState } from "react";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { formatGbp, round2 } from "@/lib/money";
import { setJobBudget, type BudgetFormValues } from "./actions";

/**
 * Set / revise a job's cost baseline. MOBILE FIRST (375px) — one column, 16px
 * inputs so iOS does not zoom the viewport on focus, `inputMode="decimal"` so
 * the numeric keypad opens.
 *
 * DESIGN NOTES, all load-bearing:
 *
 *  - TOTAL-ONLY IS THE DEFAULT. A builder who knows "this one's about £40k"
 *    should be able to say so and get a variance the same afternoon. Bucket
 *    detail is a disclosure the operator opts into, never a gate.
 *  - WHEN DETAIL IS ON, THE TOTAL IS DERIVED (Σ of the four) and shown read-only.
 *    Two editable numbers that must agree is a bug waiting for a Friday: one of
 *    them is always the stale one. Every pound lands in a named bucket — `misc`
 *    is the honest home for the ones you cannot name, and it is exactly where
 *    `mapToCostBucket` sends every unrecognised ACTUAL cost, so plan and actual
 *    share one taxonomy.
 *  - NOTHING IS PRE-FILLED WITH ZEROS on a first baseline. A pre-filled 0 is how
 *    a tap becomes a figure nobody chose. On a REVISION the current values are
 *    seeded, because a revision is an edit of a real plan.
 *  - A REVISION DEMANDS A REASON, and the field says so before submit rather
 *    than after the database refuses it (the CHECK is the backstop).
 *  - HARD NAVIGATION on success (window.location.assign): this route is four
 *    segments deep, exactly where Next 15.5 drops client-side navigations — the
 *    save lands and the URL never moves, so the operator saves it twice.
 */

export type CurrentBudget = {
  revision: number;
  total: number;
  labour: number | null;
  materials: number | null;
  subcontractors: number | null;
  misc: number | null;
  targetMarginPct: number | null;
};

const n = (v: string): number => {
  const parsed = Number(v);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function BudgetForm({
  jobId,
  current,
}: {
  jobId: string;
  current: CurrentBudget | null;
}) {
  const bound = setJobBudget.bind(null, jobId);
  const [state, action, pending] = useActionState<FormState<BudgetFormValues>, FormData>(
    bound,
    INITIAL_FORM_STATE as FormState<BudgetFormValues>,
  );
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(current?.labour != null);
  const [total, setTotal] = useState(current ? String(current.total) : "");
  const [labour, setLabour] = useState(current?.labour != null ? String(current.labour) : "");
  const [materials, setMaterials] = useState(
    current?.materials != null ? String(current.materials) : "",
  );
  const [subs, setSubs] = useState(
    current?.subcontractors != null ? String(current.subcontractors) : "",
  );
  const [misc, setMisc] = useState(current?.misc != null ? String(current.misc) : "");
  const [target, setTarget] = useState(
    current?.targetMarginPct != null ? String(current.targetMarginPct) : "",
  );

  useEffect(() => {
    if (state.ok && state.redirectTo) window.location.assign(state.redirectTo);
  }, [state.ok, state.redirectTo, state.submittedAt]);

  const derivedTotal = round2(n(labour) + n(materials) + n(subs) + n(misc));
  const effectiveTotal = detail ? derivedTotal : round2(n(total));
  const isRevision = current !== null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 shadow-sm hover:bg-slate-50 sm:w-auto"
      >
        {isRevision ? "Revise budget" : "Set a budget"}
      </button>
    );
  }

  return (
    <form action={action} className="space-y-4">
      {state.error ? (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {state.error}
        </p>
      ) : null}

      <fieldset className="space-y-3" disabled={pending}>
        <legend className="sr-only">
          {isRevision ? `Revise the budget (revision ${current.revision + 1})` : "Set the budget"}
        </legend>

        {detail ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Money label="Labour" name="labour_cost" value={labour} onChange={setLabour} error={state.fieldErrors.labour_cost} />
              <Money label="Materials" name="materials_cost" value={materials} onChange={setMaterials} error={state.fieldErrors.materials_cost} />
              <Money label="Subcontractors" name="subcontractors_cost" value={subs} onChange={setSubs} error={state.fieldErrors.subcontractors_cost} />
              <Money label="Other" name="misc_cost" value={misc} onChange={setMisc} error={state.fieldErrors.misc_cost} />
            </div>
            <p className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">
              Budget total <span className="font-semibold text-slate-900">{formatGbp(derivedTotal)}</span>{" "}
              <span className="text-xs text-slate-500">— the four figures, added up</span>
            </p>
          </>
        ) : (
          <Money
            label="Budget cost (excl. VAT)"
            name="total_cost"
            value={total}
            onChange={setTotal}
            error={state.fieldErrors.total_cost}
            help="What you expect this job to COST you — not what you're charging."
          />
        )}

        <input type="hidden" name="detail" value={detail ? "on" : ""} />
        <button
          type="button"
          onClick={() => setDetail((d) => !d)}
          className="text-xs font-medium text-slate-700 underline"
        >
          {detail ? "Use a single total instead" : "Break it down by labour / materials / subcontractors / other"}
        </button>

        <label className="block text-xs text-slate-600">
          Target margin % (optional)
          <input
            type="number"
            name="target_margin_pct"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            inputMode="decimal"
            min={0}
            max={95}
            step={0.5}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-base"
          />
          <span className="mt-1 block text-[11px] text-slate-500">
            Leave blank to use the standard 30% / 15% bands. Set it and this job&apos;s margin is
            judged against your own number.
          </span>
          {state.fieldErrors.target_margin_pct ? (
            <span className="mt-1 block text-[11px] text-red-700">
              {state.fieldErrors.target_margin_pct}
            </span>
          ) : null}
        </label>

        <label className="block text-xs text-slate-600">
          {isRevision ? "Why is it changing?" : "Note (optional)"}
          <textarea
            name="note"
            rows={2}
            required={isRevision}
            placeholder={
              isRevision
                ? "e.g. Ground conditions worse than surveyed — extra muck-away"
                : undefined
            }
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-base"
          />
          {isRevision ? (
            <span className="mt-1 block text-[11px] text-slate-500">
              Revision {current.revision + 1}. The original stays on record — a budget that can be
              quietly rewritten proves nothing.
            </span>
          ) : null}
        </label>
      </fieldset>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={pending || (effectiveTotal <= 0 && target.trim() === "")}
          className="rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 disabled:opacity-50"
        >
          {pending ? "Saving…" : isRevision ? "Save revision" : "Save budget"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function Money({
  label,
  name,
  value,
  onChange,
  error,
  help,
}: {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  help?: string;
}) {
  return (
    <label className="block text-xs text-slate-600">
      {label} (£)
      <input
        type="number"
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="decimal"
        min={0}
        step={0.01}
        /* 16px (text-base) so iOS does not zoom the viewport on focus. */
        className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-base"
      />
      {help ? <span className="mt-1 block text-[11px] text-slate-500">{help}</span> : null}
      {error ? <span className="mt-1 block text-[11px] text-red-700">{error}</span> : null}
    </label>
  );
}
