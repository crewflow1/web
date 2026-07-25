"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { INITIAL_FORM_STATE } from "@/lib/forms/state";
import { recordAllocatedPayment } from "../allocate-actions";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABEL } from "@/lib/payments/schema";
import {
  computePaymentAllocation,
  PAYMENT_ALLOCATION_STATUS_CLASS,
  PAYMENT_ALLOCATION_STATUS_LABEL,
} from "@/lib/payments/allocation";

export type OutstandingInvoice = {
  id: string;
  number: string;
  customerName: string | null;
  total: number;
  outstanding: number;
  dueDate: string | null;
};

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function AllocatePaymentForm({ invoices }: { invoices: OutstandingInvoice[] }) {
  const [state, formAction, pending] = useActionState(recordAllocatedPayment, INITIAL_FORM_STATE);
  const router = useRouter();

  const [amount, setAmount] = useState("");
  // Per-invoice allocation amount, keyed by invoice id (blank = not allocated).
  const [alloc, setAlloc] = useState<Record<string, string>>({});

  useEffect(() => {
    if (state.ok && state.redirectTo) router.push(state.redirectTo);
  }, [state.ok, state.redirectTo, state.submittedAt, router]);

  const paymentAmount = Number(amount) || 0;

  const allocations = useMemo(
    () =>
      invoices
        .map((inv) => ({ invoice_id: inv.id, amount: Number(alloc[inv.id]) || 0 }))
        .filter((a) => a.amount > 0),
    [invoices, alloc],
  );

  const position = useMemo(
    () => computePaymentAllocation({ paymentAmount, allocations }),
    [paymentAmount, allocations],
  );

  const canSubmit =
    !pending &&
    paymentAmount > 0 &&
    allocations.length > 0 &&
    position.status !== "over_allocated";

  // Fill an invoice's allocation with whatever is smaller: its outstanding
  // balance, or the payment's remaining unallocated headroom.
  function autoFill(inv: OutstandingInvoice) {
    const headroom = Math.max(0, position.unallocated + (Number(alloc[inv.id]) || 0));
    const fill = Math.min(inv.outstanding, headroom);
    setAlloc((prev) => ({ ...prev, [inv.id]: fill > 0 ? fill.toFixed(2) : "" }));
  }

  return (
    <form action={formAction} className="space-y-6">
      {state.error ? (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </div>
      ) : null}

      {/* Payment header */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-base font-semibold text-slate-900">Payment received</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Amount (£)</span>
            <input
              name="amount"
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Date received</span>
            <input
              name="paid_at"
              type="date"
              required
              defaultValue={todayIso()}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Method</span>
            <select
              name="method"
              defaultValue="bank_transfer"
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_METHOD_LABEL[m]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">Reference</span>
            <input
              name="reference"
              maxLength={200}
              placeholder="Bank ref / cheque no."
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-900 focus:outline-none"
            />
          </label>
        </div>
      </section>

      {/* Allocations */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-900">Allocate to invoices</h2>
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${PAYMENT_ALLOCATION_STATUS_CLASS[position.status]}`}>
            {PAYMENT_ALLOCATION_STATUS_LABEL[position.status]}
          </span>
        </div>

        <div className="space-y-2">
          {invoices.map((inv) => (
            <div key={inv.id} className="flex items-center gap-3 rounded-md border border-slate-100 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900">
                  {inv.number}
                  {inv.customerName ? <span className="font-normal text-slate-500"> · {inv.customerName}</span> : null}
                </p>
                <p className="text-xs text-slate-500">
                  {GBP.format(inv.outstanding)} outstanding
                  {inv.dueDate ? ` · due ${inv.dueDate}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => autoFill(inv)}
                className="shrink-0 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                Fill
              </button>
              <input
                inputMode="decimal"
                value={alloc[inv.id] ?? ""}
                onChange={(e) => setAlloc((prev) => ({ ...prev, [inv.id]: e.target.value }))}
                placeholder="0.00"
                aria-label={`Allocation for ${inv.number}`}
                className="w-28 shrink-0 rounded-md border border-slate-300 px-3 py-2 text-right text-sm focus:border-slate-900 focus:outline-none"
              />
            </div>
          ))}
        </div>

        {/* Live running totals */}
        <dl className="mt-4 space-y-1 border-t border-slate-100 pt-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-slate-500">Payment</dt>
            <dd className="text-slate-900">{GBP.format(position.paymentAmount)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-slate-500">Allocated</dt>
            <dd className="text-slate-900">{GBP.format(position.allocated)}</dd>
          </div>
          <div className="flex justify-between font-semibold">
            <dt className={position.status === "over_allocated" ? "text-red-700" : "text-slate-900"}>
              {position.status === "over_allocated" ? "Over-allocated by" : "Unallocated"}
            </dt>
            <dd className={position.status === "over_allocated" ? "text-red-700" : "text-slate-900"}>
              {position.status === "over_allocated"
                ? GBP.format(position.allocated - position.paymentAmount)
                : GBP.format(position.unallocated)}
            </dd>
          </div>
        </dl>

        {position.status === "over_allocated" ? (
          <p className="mt-2 text-xs text-red-600">
            Allocations exceed the payment. Reduce an allocation before saving.
          </p>
        ) : null}
      </section>

      {/* Serialised allocations for the server action. */}
      <input type="hidden" name="allocations" value={JSON.stringify(allocations)} />

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? "Recording…" : "Record payment"}
        </button>
        <span className="text-xs text-slate-500">
          {allocations.length} invoice{allocations.length === 1 ? "" : "s"} selected
        </span>
      </div>
    </form>
  );
}
