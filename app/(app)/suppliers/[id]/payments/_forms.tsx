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
import {
  REVERSE_CHARGE_LEGEND,
  REVERSE_CHARGE_RATES,
  VAT_TREATMENTS,
  VAT_TREATMENT_DESCRIPTIONS,
  VAT_TREATMENT_LABELS,
  computeBillBasis,
  validateCisPaymentDraft,
  type BillBasis,
  type PriorSettlement,
  type VatTreatment,
} from "@/lib/cis/deduction";

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
// H2-CIS M3 — the deduction basis of one bill
// ---------------------------------------------------------------------------

export type BillCisRow = {
  id: string;
  label: string;
  /** finances.amount — NET, ex-VAT. */
  net: number;
  /** net + vat_total — what a payment settles. */
  gross: number;
  outstanding: number;
  materials: number;
  citbLevy: number;
  vatTreatment: VatTreatment;
  reverseChargeRate: number | null;
  /** True once a live CIS payment has landed — the split is then frozen. */
  locked: boolean;
  /**
   * What LIVE payments have already settled and deducted against this bill.
   *
   * Passed through so the on-screen preview uses the same CUMULATIVE method the
   * database will. Without it a part-paid bill previews a penny out on the very
   * rounding case this milestone exists to get right, which would quietly teach
   * the operator not to trust the figure.
   */
  prior: PriorSettlement;
};

/**
 * Edit the labour/materials split and VAT treatment of one bill.
 *
 * WHY THIS SCREEN EXISTS AT ALL: CIS is deducted from the LABOUR element only.
 * Deducting from the whole bill over-deducts from the subcontractor and files a
 * wrong return, so the split cannot be guessed and cannot be skipped silently —
 * with no figure entered the whole net value is treated as labour, which
 * over-deducts rather than under-deducts, and the form says so.
 */
export function BillCisDetailsForm({
  action,
  bill,
}: {
  action: ActionFn;
  bill: BillCisRow;
}) {
  const [state, formAction, pending] = useActionState<FormState<Values>, FormData>(
    action,
    INITIAL_FORM_STATE,
  );
  const [materials, setMaterials] = useState(bill.materials ? String(bill.materials) : "");
  const [citb, setCitb] = useState(bill.citbLevy ? String(bill.citbLevy) : "");
  const [treatment, setTreatment] = useState<VatTreatment>(bill.vatTreatment);
  const [rcRate, setRcRate] = useState(
    bill.reverseChargeRate != null ? String(bill.reverseChargeRate) : "20",
  );

  const basis = useMemo(() => {
    const m = Math.max(0, Number(materials) || 0);
    const c = Math.max(0, Number(citb) || 0);
    return Math.round(Math.max(0, bill.net - c - m) * 100) / 100;
  }, [materials, citb, bill.net]);

  const over = Math.round(((Number(materials) || 0) + (Number(citb) || 0)) * 100) / 100 > bill.net;

  if (bill.locked) {
    return (
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md bg-slate-50 p-3 text-xs sm:grid-cols-4">
        <Fact label="Bill (ex VAT)" value={formatGbp(bill.net)} />
        <Fact label="Materials" value={formatGbp(bill.materials)} />
        <Fact label="Labour (CIS basis)" value={formatGbp(basis)} />
        <Fact label="VAT" value={VAT_TREATMENT_LABELS[bill.vatTreatment]} />
        <p className="col-span-full mt-1 text-[11px] text-slate-500">
          Locked — this bill has been part-paid under CIS. Void the payment to change the split.
        </p>
      </dl>
    );
  }

  return (
    <FormShell state={state} action={formAction} className="space-y-3 rounded-md bg-slate-50 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-700">Materials (£)</span>
          <input
            name="materials_amount"
            inputMode="decimal"
            value={materials}
            onChange={(e) => setMaterials(e.target.value)}
            placeholder="0.00"
            className="block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm tabular-nums focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
          <span className="mt-1 block text-[11px] leading-tight text-slate-500">
            What THEY paid for materials, consumable stores, plant hire, prefab and fuel — but not
            fuel for travelling. CIS is not deducted from this.
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-700">CITB levy (£)</span>
          <input
            name="citb_levy_amount"
            inputMode="decimal"
            value={citb}
            onChange={(e) => setCitb(e.target.value)}
            placeholder="0.00"
            className="block min-h-[44px] w-full rounded-md border border-slate-300 px-3 py-2 text-sm tabular-nums focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
          <span className="mt-1 block text-[11px] leading-tight text-slate-500">
            Levy recouped from them. It comes off the gross payment you report, before materials.
          </span>
        </label>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-700">VAT treatment</span>
          <select
            name="vat_treatment"
            value={treatment}
            onChange={(e) => setTreatment(e.target.value as VatTreatment)}
            className="block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          >
            {VAT_TREATMENTS.map((t) => (
              <option key={t} value={t}>
                {VAT_TREATMENT_LABELS[t]}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-[11px] leading-tight text-slate-500">
            {VAT_TREATMENT_DESCRIPTIONS[treatment]}
          </span>
        </label>

        {treatment === "reverse_charge" ? (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-700">
              VAT rate you account for
            </span>
            <select
              name="reverse_charge_vat_rate"
              value={rcRate}
              onChange={(e) => setRcRate(e.target.value)}
              className="block min-h-[44px] w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            >
              {REVERSE_CHARGE_RATES.map((r) => (
                <option key={r} value={r}>
                  {r}%
                </option>
              ))}
            </select>
            <span className="mt-1 block text-[11px] leading-tight text-slate-500">
              {REVERSE_CHARGE_LEGEND}. Their invoice shows no VAT — you post it as output tax and
              recover it as input tax.
            </span>
          </label>
        ) : (
          <input type="hidden" name="reverse_charge_vat_rate" value="" />
        )}
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-slate-200 pt-2 text-xs sm:grid-cols-4">
        <Fact label="Bill (ex VAT)" value={formatGbp(bill.net)} />
        <Fact label="Materials" value={formatGbp(Number(materials) || 0)} />
        <Fact label="CITB levy" value={formatGbp(Number(citb) || 0)} />
        <Fact label="Labour (CIS basis)" value={formatGbp(basis)} strong />
      </dl>

      {over ? (
        <p className="text-[11px] text-amber-800">
          Materials plus the levy come to more than the bill&apos;s net value.
        </p>
      ) : null}

      <SubmitButton
        pending={pending}
        disabled={pending || over}
        className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-60"
      >
        Save CIS details
      </SubmitButton>
    </FormShell>
  );
}

function Fact({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <dt className="text-slate-500">{label}</dt>
      <dd
        className={`tabular-nums ${strong ? "font-semibold text-slate-900" : "text-slate-800"}`}
      >
        {value}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// H2-CIS M3 — record a CIS payment (the deduction is WORKED OUT, not typed)
// ---------------------------------------------------------------------------

/**
 * The CIS payment form.
 *
 * THE DIFFERENCE FROM THE M2 FORM ABOVE: there is no "CIS withheld" input. The
 * deduction is derived from the labour element of each bill and the verified
 * rate, shown live, and recomputed server-side — the number on screen is a
 * PREVIEW of what the database will calculate, never an instruction to it.
 *
 * `expected_rate` is posted as a hidden field so a rate that changed between
 * render and submit is REFUSED rather than silently applied. That is the one
 * rate-shaped thing the client sends, and it can only cause a rejection.
 */
export function RecordCisPaymentForm({
  action,
  bills,
  defaultDate,
  rate,
  rateLabel,
}: {
  action: ActionFn;
  bills: BillCisRow[];
  defaultDate: string;
  rate: number;
  rateLabel: string;
}) {
  const [state, formAction, pending] = useActionState<FormState<Values>, FormData>(
    action,
    INITIAL_FORM_STATE,
  );
  const [lines, setLines] = useState<Record<string, string>>({});

  const outstandingByBill = useMemo(
    () => new Map(bills.map((b) => [b.id, b.outstanding])),
    [bills],
  );

  const basisById = useMemo(() => {
    const m = new Map<string, BillBasis>();
    for (const b of bills) {
      m.set(
        b.id,
        computeBillBasis(
          { amount: b.net, vat_total: Math.round((b.gross - b.net) * 100) / 100 },
          {
            materials_amount: b.materials,
            citb_levy_amount: b.citbLevy,
            vat_treatment: b.vatTreatment,
            reverse_charge_vat_rate: b.reverseChargeRate,
          },
        ),
      );
    }
    return m;
  }, [bills]);

  const draftLines = useMemo(
    () =>
      bills
        .map((b) => ({
          financeId: b.id,
          amount: Number(lines[b.id]) || 0,
          bill: basisById.get(b.id)!,
          // The SAME cumulative method the database uses, fed the same priors —
          // so the preview matches the figure that gets frozen, to the penny.
          prior: b.prior,
        }))
        .filter((l) => l.amount > 0),
    [bills, lines, basisById],
  );

  const allocations = useMemo(
    () => draftLines.map((l) => ({ finance_id: l.financeId, amount: l.amount })),
    [draftLines],
  );

  const validation = useMemo(
    () => validateCisPaymentDraft({ lines: draftLines, rate, outstandingByBill }),
    [draftLines, rate, outstandingByBill],
  );
  const preview = validation.preview;
  const canSubmit = !pending && validation.ok && preview.settled > 0;

  function fill(bill: BillCisRow) {
    setLines((prev) => ({
      ...prev,
      [bill.id]: bill.outstanding > 0 ? bill.outstanding.toFixed(2) : "",
    }));
  }

  return (
    <FormShell state={state} action={formAction} className="space-y-5">
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
            No open bills. A CIS deduction is worked out from a bill, so enter the bill first.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {bills.map((bill) => {
              const basis = basisById.get(bill.id)!;
              return (
                <li
                  key={bill.id}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-slate-100 px-3 py-2 sm:flex-nowrap"
                >
                  <div className="min-w-0 flex-1 basis-full sm:basis-auto">
                    <p className="truncate text-sm font-medium text-slate-900">{bill.label}</p>
                    <p className="text-xs text-slate-500 tabular-nums">
                      {formatGbp(bill.outstanding)} outstanding · labour{" "}
                      {formatGbp(basis.basis)} · materials {formatGbp(basis.materials)}
                      {basis.vatTreatment === "reverse_charge" ? " · reverse charge" : ""}
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
                    onChange={(e) => setLines((prev) => ({ ...prev, [bill.id]: e.target.value }))}
                    placeholder="0.00"
                    aria-label={`Amount to pay against ${bill.label}`}
                    className="min-h-[44px] w-24 shrink-0 rounded-md border border-slate-300 px-3 py-2 text-right text-sm tabular-nums focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ── The worked calculation ────────────────────────────────────────── */}
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          CIS calculation
        </h3>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-4">
          <Line label="Bill amount" value={formatGbp(preview.settled)} />
          <Line label="Labour" value={formatGbp(preview.basis)} />
          <Line label="Materials" value={formatGbp(preview.materials)} />
          <Line
            label="VAT treatment"
            value={preview.hasReverseCharge ? "Reverse charge" : "Normal VAT"}
          />
          <Line label="CIS basis" value={formatGbp(preview.basis)} />
          <Line label="Rate" value={rateLabel} />
          <Line label="CIS withheld" value={formatGbp(preview.deduction)} tone="amber" />
          <Line label="Cash paid" value={formatGbp(preview.cashOut)} strong />
        </dl>

        {preview.hasReverseCharge ? (
          <p className="mt-2 border-t border-slate-200 pt-2 text-[11px] leading-tight text-slate-600">
            {REVERSE_CHARGE_LEGEND}. {formatGbp(preview.reverseChargeVat)} of VAT is yours to
            account for on this payment — the subcontractor charges none, and you recover the same
            amount as input tax.
          </p>
        ) : null}

        <p className="mt-2 text-[11px] leading-tight text-slate-500">
          Worked out from the labour element only. These are the figures before rounding across
          part payments — the final amount is recalculated and locked when you record it.
        </p>
      </div>

      {preview.deduction > 0 ? (
        <p className="-mt-2 text-xs text-amber-800">
          The {formatGbp(preview.deduction)} you hold back is HMRC&apos;s, not yours. The job still
          cost the full bill — your margin does not change.
        </p>
      ) : null}

      {validation.errors.length > 0 ? (
        <ul className="space-y-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {validation.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}

      <input type="hidden" name="allocations" value={JSON.stringify(allocations)} />
      <input type="hidden" name="expected_rate" value={String(rate)} />

      <div className="flex flex-wrap items-center gap-3 pt-1">
        <SubmitButton pending={pending} disabled={!canSubmit}>
          Record CIS payment
        </SubmitButton>
        <span className="text-xs text-slate-500">
          {allocations.length} bill{allocations.length === 1 ? "" : "s"} selected
        </span>
      </div>
      <p className="text-xs text-slate-500">
        Once recorded, the rate, the basis and the deduction are frozen to this payment. Verifying
        the subcontractor again later will not change it. To fix one, void it and record another.
      </p>
    </FormShell>
  );
}

function Line({
  label,
  value,
  tone,
  strong,
}: {
  label: string;
  value: string;
  tone?: "amber";
  strong?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd
        className={`tabular-nums ${
          tone === "amber"
            ? "font-semibold text-amber-800"
            : strong
              ? "font-semibold text-slate-900"
              : "text-slate-800"
        }`}
      >
        {value}
      </dd>
    </div>
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
