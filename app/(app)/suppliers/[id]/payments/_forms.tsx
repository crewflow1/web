"use client";

import { useActionState, useMemo, useState } from "react";

import { FormShell, SubmitButton } from "@/components/forms/FormShell";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { formatGbp } from "@/lib/money";
import {
  SUPPLIER_PAYMENT_METHODS,
  SUPPLIER_PAYMENT_METHOD_LABEL,
  validateSupplierPaymentDraft,
} from "@/lib/suppliers/payments";

/**
 * H2-CIS M2 forms — record a supplier payment, and void one.
 *
 * MOBILE-FIRST. This is an owner standing in a yard with a phone, not an
 * accounts clerk at a desk: one column by default, 44px tap targets, the bill
 * rows stack rather than becoming a table, and every running total is visible
 * without scrolling back up.
 *
 * The live validation here mirrors `validateSupplierPaymentDraft` exactly and
 * is a COURTESY — the database enforces every one of these rules with CHECKs,
 * composite FKs and a FOR UPDATE-locked guard, and refuses a direct API caller
 * that never runs this file.
 */

type Values = Record<string, unknown>;
type ActionFn = (prev: FormState<Values>, formData: FormData) => Promise<FormState<Values>>;

export type PayableBill = {
  id: string;
  label: string;
  /** GROSS value of the bill (net + VAT) — what the supplier is owed. */
  gross: number;
  /** Still to pay on this bill. */
  outstanding: number;
  billDate: string | null;
};

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

// ---------------------------------------------------------------------------
// Record a payment
// ---------------------------------------------------------------------------

export function RecordSupplierPaymentForm({
  action,
  bills,
  defaultDate,
  cisRate,
  hasCisProfile,
}: {
  action: ActionFn;
  bills: PayableBill[];
  defaultDate: string;
  /** The subcontractor's verified CIS rate, when there is one. */
  cisRate: number | null;
  hasCisProfile: boolean;
}) {
  const [state, formAction, pending] = useActionState<FormState<Values>, FormData>(
    action,
    INITIAL_FORM_STATE,
  );

  const [gross, setGross] = useState("");
  const [withheld, setWithheld] = useState("");
  const [lines, setLines] = useState<Record<string, string>>({});

  const outstandingByBill = useMemo(
    () => new Map(bills.map((b) => [b.id, b.outstanding])),
    [bills],
  );

  const allocations = useMemo(
    () =>
      bills
        .map((b) => ({ finance_id: b.id, amount: Number(lines[b.id]) || 0 }))
        .filter((a) => a.amount > 0),
    [bills, lines],
  );

  const draft = useMemo(
    () =>
      validateSupplierPaymentDraft(
        {
          grossAmount: gross,
          cisWithheld: withheld,
          allocations: allocations.map((a) => ({ financeId: a.finance_id, amount: a.amount })),
        },
        outstandingByBill,
      ),
    [gross, withheld, allocations, outstandingByBill],
  );

  const canSubmit = !pending && draft.ok && draft.gross > 0;

  /** Fill a bill with the smaller of its outstanding balance and the headroom left. */
  function fill(bill: PayableBill) {
    const headroom = Math.max(0, draft.unallocated + (Number(lines[bill.id]) || 0));
    const value = Math.min(bill.outstanding, headroom);
    setLines((prev) => ({ ...prev, [bill.id]: value > 0 ? value.toFixed(2) : "" }));
  }

  return (
    <FormShell state={state} action={formAction} className="space-y-6">
      {/* ── The money ─────────────────────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-800">
            Amount settled (£)<span className="ml-0.5 text-red-500">*</span>
          </span>
          <input
            name="gross_amount"
            inputMode="decimal"
            required
            value={gross}
            onChange={(e) => setGross(e.target.value)}
            placeholder="0.00"
            className="block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
          <span className="mt-1 block text-xs text-slate-500">
            The value knocked off their account, VAT included — before any CIS deduction.
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-800">CIS withheld (£)</span>
          <input
            name="cis_withheld"
            inputMode="decimal"
            value={withheld}
            onChange={(e) => setWithheld(e.target.value)}
            placeholder="0.00"
            disabled={!hasCisProfile}
            className="block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 disabled:bg-slate-50 disabled:text-slate-400"
          />
          <span className="mt-1 block text-xs text-slate-500">
            {!hasCisProfile
              ? "Not a CIS subcontractor — set up their CIS details to deduct."
              : cisRate != null
                ? `Verified at ${cisRate}%. Deduct that from the LABOUR element only — not materials, plant hire or VAT. CrewFlow does not work it out for you.`
                : "No current verification, so there is no authority to deduct. Verify with HMRC first."}
          </span>
        </label>
      </div>

      {/* Derived cash line — never an input, so the triple always adds up. */}
      <dl className="grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 text-center">
        <div>
          <dt className="text-xs text-slate-500">Settled</dt>
          <dd className="text-sm font-semibold tabular-nums text-slate-900">
            {formatGbp(draft.gross)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">CIS held</dt>
          <dd className="text-sm font-semibold tabular-nums text-amber-800">
            {formatGbp(draft.withheld)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Cash out</dt>
          <dd className="text-sm font-semibold tabular-nums text-slate-900">
            {formatGbp(draft.net)}
          </dd>
        </div>
      </dl>
      {draft.withheld > 0 ? (
        <p className="-mt-3 text-xs text-amber-800">
          The {formatGbp(draft.withheld)} you hold back is HMRC&apos;s, not yours. The job still
          cost the full {formatGbp(draft.gross)} — your margin does not change.
        </p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-800">
            Date paid<span className="ml-0.5 text-red-500">*</span>
          </span>
          <input
            name="paid_at"
            type="date"
            required
            defaultValue={defaultDate}
            className="block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium text-slate-800">Method</span>
          <select
            name="method"
            defaultValue="bank_transfer"
            className="block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          >
            {SUPPLIER_PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {SUPPLIER_PAYMENT_METHOD_LABEL[m]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-800">Reference</span>
        <input
          name="reference"
          maxLength={120}
          placeholder="Bank ref / cheque no."
          className="block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
      </label>

      {/* ── Which bills this settles ──────────────────────────────────────── */}
      <div>
        <h3 className="text-sm font-semibold text-slate-900">Bills this payment settles</h3>
        {bills.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">
            No open bills for this supplier. You can still record the payment — it will sit on
            account until a bill is entered.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {bills.map((bill) => (
              <li
                key={bill.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-slate-100 px-3 py-2 sm:flex-nowrap"
              >
                <div className="min-w-0 flex-1 basis-full sm:basis-auto">
                  <p className="truncate text-sm font-medium text-slate-900">{bill.label}</p>
                  <p className="text-xs text-slate-500 tabular-nums">
                    {formatGbp(bill.outstanding)} outstanding of {formatGbp(bill.gross)}
                    {bill.billDate ? ` · ${fmtDate(bill.billDate)}` : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => fill(bill)}
                  className="min-h-[44px] shrink-0 rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  Fill
                </button>
                <input
                  inputMode="decimal"
                  value={lines[bill.id] ?? ""}
                  onChange={(e) =>
                    setLines((prev) => ({ ...prev, [bill.id]: e.target.value }))
                  }
                  placeholder="0.00"
                  aria-label={`Amount to pay against ${bill.label}`}
                  className="min-h-[44px] w-24 shrink-0 rounded-md border border-slate-300 px-3 py-2 text-right text-sm tabular-nums focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                />
              </li>
            ))}
          </ul>
        )}

        <dl className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-slate-500">Allocated to bills</dt>
            <dd className="tabular-nums text-slate-900">{formatGbp(draft.allocated)}</dd>
          </div>
          <div className="flex justify-between font-semibold">
            <dt className="text-slate-900">Left on account</dt>
            <dd className="tabular-nums text-slate-900">{formatGbp(draft.unallocated)}</dd>
          </div>
        </dl>
      </div>

      {draft.errors.length > 0 ? (
        <ul className="space-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {draft.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}

      <input type="hidden" name="allocations" value={JSON.stringify(allocations)} />

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <SubmitButton pending={pending} disabled={!canSubmit}>
          Record payment
        </SubmitButton>
        <span className="text-xs text-slate-500">
          {allocations.length} bill{allocations.length === 1 ? "" : "s"} selected
        </span>
      </div>
      <p className="text-xs text-slate-500">
        Once recorded a payment can&apos;t be edited or deleted — it&apos;s a tax record. To fix
        one, void it and record the correct payment.
      </p>
    </FormShell>
  );
}

// ---------------------------------------------------------------------------
// Void a payment
// ---------------------------------------------------------------------------

export function VoidPaymentForm({
  action,
  paymentId,
}: {
  action: ActionFn;
  paymentId: string;
}) {
  const [state, formAction, pending] = useActionState<FormState<Values>, FormData>(
    action,
    INITIAL_FORM_STATE,
  );
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="min-h-[44px] rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-600 hover:bg-slate-50"
      >
        Void
      </button>
    );
  }

  return (
    <FormShell
      state={state}
      action={formAction}
      className="w-full space-y-2 rounded-md border border-amber-200 bg-amber-50/60 p-3"
    >
      <input type="hidden" name="payment_id" value={paymentId} />
      <p className="text-xs text-amber-900">
        Voiding keeps the payment on record and stops it counting. Say why.
      </p>
      <input
        name="void_reason"
        required
        maxLength={500}
        placeholder="e.g. Keyed the wrong amount"
        aria-label="Reason for voiding"
        className="block min-h-[44px] w-full rounded-md border border-amber-300 px-3 py-2 text-sm focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500"
      />
      <div className="flex flex-wrap gap-2">
        <SubmitButton
          pending={pending}
          className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-amber-300 bg-white px-4 py-2.5 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-60"
        >
          Void payment
        </SubmitButton>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="min-h-[44px] px-3 text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Cancel
        </button>
      </div>
    </FormShell>
  );
}
