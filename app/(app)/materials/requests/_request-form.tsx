"use client";

import { useActionState, useEffect, useState } from "react";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { FormErrorBanner } from "@/components/forms/Field";
import {
  MATERIAL_REQUEST_PRIORITIES,
  MATERIAL_REQUEST_PRIORITY_LABEL,
  type MaterialRequestFormInput,
} from "@/lib/material-requests/schema";

/**
 * The worker's "I need this on site" form.
 *
 * MOBILE-FIRST, AND MEANT IT. This is used one-handed, outdoors, in gloves, on
 * a 375px phone. Every decision below follows from that:
 *   · Lines stack as CARDS, never a table — a 5-column table at 375px gives
 *     each cell about 60px and turns every description into four lines.
 *   · Description is the first and biggest field, because free text is the
 *     PRIMARY path (20261066 note 1): you must be able to ask for the odd-size
 *     lintel without anyone creating a catalogue item first.
 *   · `inputMode="decimal"` on quantity brings up the number pad — a plain
 *     text keyboard here is the difference between a 2-second entry and a
 *     10-second one.
 *   · Controls are ≥44px tall (the iOS touch-target floor).
 *   · ONE primary button. "Send request" creates AND submits: 'draft' is the
 *     database's born-draft rule, not a step anyone on site should think about.
 *     "Save as draft" is present but secondary, for the half-written list.
 *
 * Lines ride as JSON in a hidden field — the established house pattern
 * (_builder.tsx for purchase orders), so the action parses one shape.
 */

type Row = { description: string; qty: string; unit: string };

const blankRow = (): Row => ({ description: "", qty: "1", unit: "ea" });

/** Units a UK site actually asks in, in rough frequency order. */
const UNITS = ["ea", "bag", "m", "m2", "m3", "box", "pack", "roll", "sheet", "t", "L"];

export function MaterialRequestForm({
  action,
  jobId,
  jobLabel,
  backHref,
}: {
  action: (
    prev: FormState<MaterialRequestFormInput>,
    formData: FormData,
  ) => Promise<FormState<MaterialRequestFormInput>>;
  jobId?: string | null;
  jobLabel?: string | null;
  backHref: string;
}) {
  const [state, formAction, pending] = useActionState(action, INITIAL_FORM_STATE);
  const [rows, setRows] = useState<Row[]>([blankRow()]);
  const [intent, setIntent] = useState<"submit" | "draft">("submit");

  // FULL DOCUMENT LOAD, never router.push. Next 15.5 silently drops a
  // navigation at route-swap depth ≥4 — the server work lands and the URL
  // simply doesn't move (the deep-swap commit race). StateForm does the same.
  useEffect(() => {
    if (state.ok && state.redirectTo) window.location.assign(state.redirectTo);
  }, [state.ok, state.redirectTo, state.submittedAt]);

  const update = (i: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const addRow = () => setRows((prev) => [...prev, blankRow()]);
  const removeRow = (i: number) =>
    setRows((prev) => (prev.length === 1 ? prev : prev.filter((_, idx) => idx !== i)));

  const payload = JSON.stringify(
    rows
      .filter((r) => r.description.trim() !== "")
      .map((r) => ({
        description: r.description.trim(),
        qty: Number(r.qty) || 0,
        unit: r.unit.trim() || "ea",
      })),
  );

  const nothingToSend = rows.every((r) => r.description.trim() === "");

  return (
    <form action={formAction} className="space-y-5">
      {state.error ? <FormErrorBanner error={state.error} /> : null}

      <input type="hidden" name="lines" value={payload} />
      <input type="hidden" name="intent" value={intent} />
      {jobId ? <input type="hidden" name="job_id" value={jobId} /> : null}

      {jobLabel ? (
        <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          For <span className="font-semibold text-slate-900">{jobLabel}</span>
        </p>
      ) : null}

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold text-slate-900">What do you need?</legend>

        {rows.map((row, i) => (
          <div
            key={i}
            className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm"
          >
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Material</span>
              <input
                value={row.description}
                onChange={(e) => update(i, { description: e.target.value })}
                placeholder="e.g. Cement 25kg"
                maxLength={500}
                autoComplete="off"
                className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
              />
            </label>

            <div className="mt-2 flex gap-2">
              <label className="w-24 shrink-0">
                <span className="text-xs font-medium text-slate-600">Qty</span>
                <input
                  value={row.qty}
                  onChange={(e) => update(i, { qty: e.target.value })}
                  // The number pad, not the alphabet keyboard.
                  inputMode="decimal"
                  className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </label>
              <label className="flex-1">
                <span className="text-xs font-medium text-slate-600">Unit</span>
                <input
                  value={row.unit}
                  onChange={(e) => update(i, { unit: e.target.value })}
                  list="material-units"
                  maxLength={20}
                  className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
                />
              </label>
              <button
                type="button"
                onClick={() => removeRow(i)}
                disabled={rows.length === 1}
                aria-label={`Remove ${row.description || `line ${i + 1}`}`}
                className="mt-5 min-h-11 shrink-0 rounded-lg border border-slate-300 px-3 text-sm text-slate-600 disabled:opacity-40"
              >
                Remove
              </button>
            </div>
          </div>
        ))}

        <datalist id="material-units">
          {UNITS.map((u) => (
            <option key={u} value={u} />
          ))}
        </datalist>

        <button
          type="button"
          onClick={addRow}
          className="min-h-11 w-full rounded-lg border border-dashed border-slate-400 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          + Add another material
        </button>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Needed by</span>
          <input
            type="date"
            name="needed_by"
            className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-slate-600">Priority</span>
          <select
            name="priority"
            defaultValue="normal"
            className="mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
          >
            {MATERIAL_REQUEST_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {MATERIAL_REQUEST_PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block">
        <span className="text-xs font-medium text-slate-600">
          Anything the office should know? <span className="text-slate-400">(optional)</span>
        </span>
        <textarea
          name="notes"
          rows={3}
          maxLength={5000}
          placeholder="e.g. deliver to the rear gate before 10am"
          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-base text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
        />
      </label>

      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <button
          type="submit"
          onClick={() => setIntent("submit")}
          disabled={pending || nothingToSend}
          className="min-h-12 flex-1 rounded-lg bg-slate-900 px-4 text-base font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {pending ? "Sending…" : "Send request"}
        </button>
        <button
          type="submit"
          onClick={() => setIntent("draft")}
          disabled={pending || nothingToSend}
          className="min-h-12 rounded-lg border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 sm:flex-none"
        >
          Save as draft
        </button>
        <a
          href={backHref}
          className="flex min-h-12 items-center justify-center rounded-lg px-4 text-sm text-slate-500 hover:text-slate-800"
        >
          Cancel
        </a>
      </div>
    </form>
  );
}
