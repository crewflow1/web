"use client";

import { useActionState, useEffect, useState } from "react";
import Link from "next/link";
import { INITIAL_FORM_STATE } from "@/lib/forms/state";
import { receiveIntoStock } from "../../stock/actions";

/**
 * "Put this into stock" — the GRN → stock bridge, on the delivery it belongs to.
 *
 * THE HUMAN PICKS THE ITEM. Purchase-order lines are FREE TEXT
 * (20261006000000): "Cement 25kg bags x40", "cement", "CEM II 25kg" are three
 * spellings of one product and no amount of matching makes them a stock
 * identity. So this form asks, every time, and NOTHING SPECULATIVE IS
 * PERSISTED — no remembered guess, no draft mapping, no "we think this is…".
 * Guessing wrong does not produce a slightly-off report; it produces a balance
 * for the wrong product that somebody counts against months later and cannot
 * reconcile.
 *
 * THE QUANTITY IS NOT ASKED FOR. It comes from the posted delivery line inside
 * the RPC, so what goes into stock is exactly what the delivery evidence says
 * arrived — there is no field here that could disagree with the GRN.
 *
 * IDEMPOTENT. A double tap in a yard with one bar of signal writes ONE movement
 * (a partial unique index on the delivery line, 20261064000000) and this form
 * shows where it went instead of offering itself again.
 */

type Props = {
  purchaseOrderId: string;
  grnLineId: string;
  description: string;
  qty: string;
  unit: string;
  items: Array<{ id: string; name: string; unit: string }>;
  sites: Array<{ id: string; name: string }>;
  stocked: { itemName: string; siteName: string } | null;
};

export function ReceiveIntoStockForm({
  purchaseOrderId,
  grnLineId,
  description,
  qty,
  unit,
  items,
  sites,
  stocked,
}: Props) {
  const [state, action, pending] = useActionState(
    receiveIntoStock.bind(null, purchaseOrderId),
    INITIAL_FORM_STATE,
  );
  const [open, setOpen] = useState(false);

  useEffect(() => {
    // Hard navigation, not router.push: this sits four route segments deep,
    // which is where Next 15.5 silently drops a client-side navigation — the
    // movement lands, the URL never moves, and the operator books it twice.
    if (state.ok && state.redirectTo) window.location.assign(state.redirectTo);
  }, [state.ok, state.redirectTo, state.submittedAt]);

  if (stocked) {
    return (
      <p className="mt-1 text-xs text-emerald-700">
        In stock as{" "}
        <span className="font-medium">{stocked.itemName}</span> at {stocked.siteName}.
      </p>
    );
  }

  if (items.length === 0 || sites.length === 0) {
    return (
      <p className="mt-1 text-xs text-slate-500">
        {items.length === 0 ? (
          <>
            <Link href="/stock/items/new" className="underline hover:text-slate-800">
              Add a stock item
            </Link>{" "}
            to be able to track this.
          </>
        ) : (
          <>
            <Link href="/sites/new" className="underline hover:text-slate-800">
              Add a depot or yard
            </Link>{" "}
            to be able to put this somewhere.
          </>
        )}
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 text-xs font-medium text-slate-600 underline hover:text-slate-900"
      >
        Put into stock
      </button>
    );
  }

  return (
    <form action={action} className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      {state.error ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800">
          {state.error}
        </p>
      ) : null}
      <input type="hidden" name="grn_line_id" value={grnLineId} />
      <p className="text-xs text-slate-600">
        Which stock item is &ldquo;{description}&rdquo;? {qty} {unit} will be added — the quantity
        comes from the delivery, not from this form.
      </p>
      <label className="block text-xs font-medium text-slate-700">
        Stock item
        <select
          name="stock_item_id"
          required
          defaultValue=""
          className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        >
          <option value="" disabled>
            — choose —
          </option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} ({i.unit})
            </option>
          ))}
        </select>
      </label>
      <label className="block text-xs font-medium text-slate-700">
        Put it where?
        <select
          name="site_id"
          required
          defaultValue=""
          className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        >
          <option value="" disabled>
            — choose —
          </option>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-slate-500">
        This records a quantity only. The cost still lands once, when you record the
        supplier&rsquo;s bill.
      </p>
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:bg-slate-300"
        >
          {pending ? "Saving…" : "Add to stock"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
