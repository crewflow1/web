"use client";

import { useActionState, useState } from "react";
import { INITIAL_FORM_STATE } from "@/lib/forms/state";
import { voidDelivery } from "../receiving-actions";

/**
 * Void a posted delivery — the ONLY correction path.
 *
 * A posted goods received note is immutable evidence (the write-once trigger in
 * 20261059000000 refuses every edit), so a mistake is corrected by voiding it
 * with a reason and recording a fresh one. The reason is mandatory in the form,
 * in the RPC and in a CHECK constraint — three layers, because a void with no
 * explanation is worse than no void at all: it destroys the number and leaves
 * nobody able to say why.
 *
 * Voiding also walks the order's status back to the truth in the same
 * transaction (received → partially_received → sent), so the copy below is a
 * promise the database keeps.
 */
export function VoidDeliveryForm({ grnId, poId }: { grnId: string; poId: string }) {
  const [state, action, pending] = useActionState(
    voidDelivery.bind(null, grnId),
    INITIAL_FORM_STATE,
  );
  const [open, setOpen] = useState(false);

  if (state.ok) {
    return <p className="mt-2 text-xs text-emerald-700">{state.successMessage ?? "Delivery voided."}</p>;
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 text-xs font-semibold text-red-700 underline underline-offset-2 hover:text-red-800"
      >
        Void this delivery
      </button>
    );
  }

  return (
    <form action={action} className="mt-2 space-y-2 rounded-md border border-red-200 bg-red-50 p-3">
      <input type="hidden" name="purchase_order_id" value={poId} />
      <label className="block text-xs font-medium text-red-800">
        Why are you voiding it?
        <input
          name="void_reason"
          type="text"
          required
          maxLength={500}
          placeholder="e.g. booked against the wrong order"
          className="mt-1 w-full rounded-md border border-red-300 bg-white px-3 py-2 text-sm focus:border-red-400 focus:outline-none"
        />
      </label>
      <p className="text-xs text-red-700">
        The note stays on the record with your reason. The order&apos;s received quantities go back
        to what they were.
      </p>
      {state.error ? (
        <p role="alert" className="text-xs font-semibold text-red-800">
          {state.error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-red-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-800 disabled:opacity-60"
        >
          {pending ? "Voiding…" : "Void delivery"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-100"
        >
          Keep it
        </button>
      </div>
    </form>
  );
}
