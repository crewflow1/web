"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { FormErrorBanner } from "@/components/forms/Field";
import { SubmitButton } from "@/components/forms/FormShell";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { formatQuantity } from "@/lib/stock/movements";
import { createReplenishmentRequest } from "../reorder-actions";

/**
 * The below-reorder worklist as a pickable form.
 *
 * Every row is a real, server-computed suggestion (lib/stock/reorder.ts) — this
 * component only tracks which ones are ticked and posts their ids. The action
 * RE-DERIVES the quantities server-side, so nothing here is trusted as a number
 * to buy; the figures shown are informational.
 *
 * HARD NAVIGATION on success (window.location.assign), never router.push: this
 * posts from a force-dynamic route, exactly where Next 15.5 drops a client-side
 * navigation and the user re-submits (the deep-swap commit race the stock and
 * materials lanes document).
 */

export type ReplenishmentRow = {
  itemId: string;
  name: string;
  unit: string;
  available: number;
  reorderPoint: number;
  suggestedQuantity: number;
  basis: "fixed_batch" | "order_up_to";
};

const BASIS_LABEL: Record<ReplenishmentRow["basis"], string> = {
  fixed_batch: "fixed re-order batch",
  order_up_to: "to reach target level",
};

export function ReplenishmentForm({ rows }: { rows: ReplenishmentRow[] }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    createReplenishmentRequest,
    INITIAL_FORM_STATE,
  );
  // Start with everything ticked — the common case is "order all of these".
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(rows.map((r) => r.itemId)),
  );

  useEffect(() => {
    if (state.ok && state.redirectTo) window.location.assign(state.redirectTo);
  }, [state.ok, state.redirectTo, state.submittedAt]);

  const selectedIds = useMemo(() => [...selected], [selected]);
  const allOn = selected.size === rows.length && rows.length > 0;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected(allOn ? new Set() : new Set(rows.map((r) => r.itemId)));
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormErrorBanner error={state.error} />
      <input type="hidden" name="item_ids" value={JSON.stringify(selectedIds)} />

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
          <input
            id="toggle-all"
            type="checkbox"
            checked={allOn}
            onChange={toggleAll}
            className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
          />
          <label htmlFor="toggle-all" className="text-sm font-medium text-slate-700">
            {allOn ? "Deselect all" : "Select all"}
          </label>
          <span className="ml-auto text-xs text-slate-500">
            {selected.size} of {rows.length} selected
          </span>
        </div>

        <ul className="divide-y divide-slate-100">
          {rows.map((r) => {
            const on = selected.has(r.itemId);
            return (
              <li key={r.itemId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <input
                  id={`pick-${r.itemId}`}
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(r.itemId)}
                  className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
                />
                <label htmlFor={`pick-${r.itemId}`} className="min-w-0 flex-1 cursor-pointer">
                  <span className="block truncate text-sm font-medium text-slate-900">
                    {r.name}
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500">
                    {formatQuantity(r.available)} {r.unit} on hand · reorder at{" "}
                    {formatQuantity(r.reorderPoint)}
                  </span>
                </label>
                <div className="shrink-0 text-right">
                  <span className="block text-sm font-semibold tabular-nums text-slate-900">
                    +{formatQuantity(r.suggestedQuantity)} {r.unit}
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-400">
                    {BASIS_LABEL[r.basis]}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pending={pending} disabled={selected.size === 0}>
          Create material request
        </SubmitButton>
        <p className="text-xs text-slate-500">
          Raises a draft request for review — no order is sent and no cost is recorded.
        </p>
      </div>
    </form>
  );
}
