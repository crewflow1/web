"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { INITIAL_FORM_STATE } from "@/lib/forms/state";
import { computeReceiving, formatQty, type ReceivingLineState } from "@/lib/purchase-orders/receiving";
import { receiveDelivery } from "../receiving-actions";

/**
 * "Receive delivery" — the yard form (Warehouse M1).
 *
 * Designed for one specific moment: a phone, one hand, a lorry waiting, a paper
 * delivery note in the other hand. Every decision below follows from that.
 *
 *   - CARDS, NOT A TABLE. A five-column table on a 375px screen is unusable;
 *     each ordered line is its own card with its numbers stacked.
 *   - NOTHING IS PRE-FILLED. The default is "nothing arrived" and the operator
 *     says what did. Pre-filling the outstanding quantity would make the fast
 *     path (tap, tap, submit) silently claim a full delivery — the exact lie
 *     this milestone exists to stop. "All arrived" is one tap away for the
 *     common case, and each line has its own "all" chip for the rest.
 *   - inputMode="decimal" + 16px text: the numeric keypad opens, and iOS does
 *     not zoom the viewport on focus.
 *   - LIVE ARITHMETIC. Each line shows what it will become, and an over-receipt
 *     turns the card red and disables submit BEFORE the round trip — the
 *     database refuses it anyway (post_goods_received_note), so the form's job
 *     is to never let it get that far.
 */

type Props = {
  poId: string;
  lines: ReceivingLineState[];
};

export function ReceiveDeliveryForm({ poId, lines }: Props) {
  const [state, action, pending] = useActionState(
    receiveDelivery.bind(null, poId),
    INITIAL_FORM_STATE,
  );
  const [open, setOpen] = useState(false);
  const [entered, setEntered] = useState<Record<string, string>>({});

  useEffect(() => {
    // Hard navigation rather than router.push: this is a one-per-delivery
    // action whose whole point is that the new note appears. A dropped
    // client-side navigation would leave the operator staring at a page that
    // looks like nothing happened, and they would post the delivery twice.
    if (state.ok && state.redirectTo) window.location.assign(state.redirectTo);
  }, [state.ok, state.redirectTo, state.submittedAt]);

  const preview = useMemo(
    () =>
      computeReceiving({
        lines: lines.map((l) => ({ id: l.lineId, description: l.description, unit: l.unit, qty: l.ordered })),
        receipts: lines.map((l) => ({
          purchase_order_line_item_id: l.lineId,
          qty_received: l.previouslyReceived,
        })),
        receivingNow: entered,
      }),
    [lines, entered],
  );

  const payload = preview.lines
    .filter((l) => l.receivingNow > 0)
    .map((l) => ({ line_item_id: l.lineId, qty_received: l.receivingNow }));

  const blocked = preview.hasOverReceipt || preview.hasInvalidEntry;
  const canSubmit = payload.length > 0 && !blocked && !pending;

  const fillAll = () =>
    setEntered(
      Object.fromEntries(
        lines.filter((l) => l.remaining > 0).map((l) => [l.lineId, String(l.remaining)]),
      ),
    );

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-lg bg-slate-900 px-4 py-3 text-base font-semibold text-white hover:bg-slate-800"
      >
        Receive delivery
      </button>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="lines" value={JSON.stringify(payload)} />

      <div className="flex items-center justify-between gap-2">
        <p className="text-base font-semibold text-slate-900">What arrived?</p>
        <button
          type="button"
          onClick={fillAll}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
        >
          All arrived
        </button>
      </div>

      <ul className="space-y-3">
        {preview.lines.map((l) => {
          const done = l.remaining <= 0;
          return (
            <li
              key={l.lineId}
              className={`rounded-lg border p-3 ${
                l.over ? "border-red-300 bg-red-50" : done ? "border-slate-200 bg-slate-50" : "border-slate-200 bg-white"
              }`}
            >
              <p className="text-sm font-medium text-slate-900">{l.description}</p>
              <p className="mt-0.5 text-xs text-slate-500">
                {formatQty(l.ordered)} {l.unit} ordered · {formatQty(l.previouslyReceived)} received so far ·{" "}
                <span className={done ? "text-emerald-700" : "font-medium text-slate-700"}>
                  {done ? "complete" : `${formatQty(l.remaining)} outstanding`}
                </span>
              </p>

              {done ? null : (
                <div className="mt-2 flex items-center gap-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label={`Quantity received for ${l.description}`}
                    placeholder="0"
                    value={entered[l.lineId] ?? ""}
                    onChange={(e) =>
                      setEntered((prev) => ({ ...prev, [l.lineId]: e.target.value }))
                    }
                    className={`w-28 rounded-md border px-3 py-2.5 text-base tabular-nums focus:outline-none ${
                      l.over ? "border-red-400 bg-white text-red-700" : "border-slate-300 focus:border-slate-400"
                    }`}
                  />
                  <span className="text-sm text-slate-500">{l.unit}</span>
                  <button
                    type="button"
                    onClick={() => setEntered((prev) => ({ ...prev, [l.lineId]: String(l.remaining) }))}
                    className="ml-auto rounded-md border border-slate-300 px-2.5 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    All {formatQty(l.remaining)}
                  </button>
                </div>
              )}

              {l.receivingNow > 0 ? (
                <p className={`mt-1.5 text-xs ${l.over ? "font-semibold text-red-700" : "text-slate-600"}`}>
                  {l.over
                    ? `Over-receipt — ${formatQty(l.receivedAfter)} against ${formatQty(l.ordered)} ordered`
                    : `→ ${formatQty(l.receivedAfter)} of ${formatQty(l.ordered)}${
                        l.complete ? " · complete" : ` · ${formatQty(l.outstanding)} still to come`
                      }`}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          <span className="text-slate-600">Delivery date</span>
          <input
            name="delivery_date"
            type="date"
            defaultValue={new Date().toISOString().slice(0, 10)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2.5 text-base focus:border-slate-400 focus:outline-none"
          />
        </label>
        <label className="text-sm">
          <span className="text-slate-600">
            Delivery note no. <span className="text-slate-400">optional</span>
          </span>
          <input
            name="delivery_note_reference"
            type="text"
            placeholder="e.g. DN-44821"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2.5 text-base focus:border-slate-400 focus:outline-none"
          />
        </label>
        <label className="text-sm sm:col-span-2">
          <span className="text-slate-600">
            Where did it land? <span className="text-slate-400">optional</span>
          </span>
          <input
            name="delivery_location"
            type="text"
            placeholder="e.g. Riverside compound, bay 2"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2.5 text-base focus:border-slate-400 focus:outline-none"
          />
        </label>
        <label className="text-sm sm:col-span-2">
          <span className="text-slate-600">
            Notes <span className="text-slate-400">optional</span>
          </span>
          <textarea
            name="notes"
            rows={2}
            placeholder="Damage, shortages, who signed for it…"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2.5 text-base focus:border-slate-400 focus:outline-none"
          />
        </label>
      </div>

      {state.error ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      ) : null}
      {preview.hasOverReceipt ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          More has arrived than was ordered. Reduce the quantity, or amend the purchase order first.
        </p>
      ) : null}
      {preview.hasInvalidEntry ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          Quantities must be numbers above zero.
        </p>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-lg bg-slate-900 px-4 py-3 text-base font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {pending
            ? "Recording…"
            : payload.length === 0
              ? "Enter what arrived"
              : `Confirm delivery · ${payload.length} line${payload.length === 1 ? "" : "s"}`}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setEntered({});
          }}
          className="rounded-lg border border-slate-300 px-4 py-3 text-base font-semibold text-slate-700 hover:bg-slate-50"
        >
          Cancel
        </button>
      </div>
      <p className="text-xs text-slate-500">
        You&apos;ll be able to add the delivery-note photo as soon as it&apos;s recorded.
      </p>
    </form>
  );
}
