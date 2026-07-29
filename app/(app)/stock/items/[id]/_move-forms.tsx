"use client";

import Link from "next/link";
import { useActionState, useEffect, useMemo, useState } from "react";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { formatQuantity } from "@/lib/stock/movements";
import {
  adjustStock,
  correctStockMovement,
  issueStock,
  transferStock,
} from "../../actions";

/**
 * Move stock — issue, transfer, adjust. MOBILE FIRST (375px), because this is
 * the one screen that gets used standing in a container with one hand.
 *
 *   - ONE ACTION AT A TIME. A tab strip, not three stacked forms: three forms
 *     on a phone is a scroll-hunt, and two of them are always wrong.
 *   - THE BALANCE IS ON SCREEN while you type, per place, and the site picker
 *     shows it inline — so "issue 40 from the lock-up" is checkable before
 *     submitting rather than after the database refuses it.
 *   - inputMode="decimal" + 16px text: the numeric keypad opens and iOS does
 *     not zoom the viewport on focus.
 *   - NOTHING IS PRE-FILLED. The quantity starts empty; a pre-filled "all of
 *     it" is how a tap becomes a false stock-take.
 *   - LIVE ARITHMETIC. The panel shows what the balance becomes and blocks
 *     submit before the round trip when it would go negative. The database
 *     refuses it anyway (that is the real rule, under a per-(item, site) lock);
 *     the form's job is to stop it getting that far.
 *
 * THE ACCOUNTING BOUNDARY: no price, no cost, nowhere to enter one. Issuing to
 * a job records the quantity and its job provenance and posts NO expense — the
 * material was costed when the supplier's bill was recorded.
 *
 * HARD NAVIGATION on success (window.location.assign): these routes are four
 * segments deep, exactly where Next 15.5 drops client-side navigations — the
 * movement lands and the URL never moves, so the operator issues it twice.
 */

type SiteOption = { id: string; name: string; balance: number };
type JobOption = { id: string; label: string };

type Tab = "issue" | "transfer" | "adjust";

export function MoveStockPanel({
  itemId,
  unit,
  sites,
  jobs,
  canAdjust,
}: {
  itemId: string;
  unit: string;
  sites: SiteOption[];
  jobs: JobOption[];
  canAdjust: boolean;
}) {
  const [tab, setTab] = useState<Tab>("issue");
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "issue", label: "Issue out" },
    { key: "transfer", label: "Move" },
    ...(canAdjust ? ([{ key: "adjust" as Tab, label: "Count" }]) : []),
  ];

  if (sites.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600 shadow-sm">
        You have no sites yet, so there is nowhere to hold stock.{" "}
        <Link href="/sites/new" className="font-medium text-slate-900 underline">
          Add a depot, yard or lock-up
        </Link>{" "}
        first.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div
        role="tablist"
        aria-label="Move stock"
        className="flex gap-1 border-b border-slate-100 p-2"
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 rounded-md px-3 py-2.5 text-sm font-semibold ${
              tab === t.key
                ? "bg-slate-900 text-white"
                : "text-slate-700 hover:bg-slate-100"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="p-4">
        {tab === "issue" ? (
          <IssueForm itemId={itemId} unit={unit} sites={sites} jobs={jobs} />
        ) : null}
        {tab === "transfer" ? <TransferForm itemId={itemId} unit={unit} sites={sites} /> : null}
        {tab === "adjust" && canAdjust ? (
          <AdjustForm itemId={itemId} unit={unit} sites={sites} />
        ) : null}
      </div>
    </div>
  );
}

function useHardRedirect(state: FormState) {
  useEffect(() => {
    if (state.ok && state.redirectTo) window.location.assign(state.redirectTo);
  }, [state.ok, state.redirectTo, state.submittedAt]);
}

function Banner({ state }: { state: FormState }) {
  if (!state.error) return null;
  return (
    <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      {state.error}
    </p>
  );
}

function SiteSelect({
  name,
  label,
  sites,
  value,
  onChange,
  unit,
}: {
  name: string;
  label: string;
  sites: SiteOption[];
  value: string;
  onChange: (v: string) => void;
  unit: string;
}) {
  return (
    <div>
      <label htmlFor={name} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <select
        id={name}
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 sm:text-sm"
      >
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} — {formatQuantity(s.balance)} {unit}
          </option>
        ))}
      </select>
    </div>
  );
}

function QtyInput({
  name,
  label,
  value,
  onChange,
  help,
  allowNegative,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  help?: string;
  allowNegative?: boolean;
}) {
  return (
    <div>
      <label htmlFor={name} className="block text-sm font-medium text-slate-800">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={value}
        onChange={(e) =>
          onChange(
            e.target.value.replace(allowNegative ? /[^0-9.\-]/g : /[^0-9.]/g, ""),
          )
        }
        className="mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-3 text-lg tabular-nums focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
      />
      {help ? <p className="mt-1 text-xs text-slate-500">{help}</p> : null}
    </div>
  );
}

function Submit({ pending, disabled, children }: { pending: boolean; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={pending || disabled}
      className="w-full rounded-lg bg-slate-900 px-4 py-3 text-base font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
    >
      {pending ? "Saving…" : children}
    </button>
  );
}

function IssueForm({
  itemId,
  unit,
  sites,
  jobs,
}: {
  itemId: string;
  unit: string;
  sites: SiteOption[];
  jobs: JobOption[];
}) {
  const [state, action, pending] = useActionState(issueStock, INITIAL_FORM_STATE);
  useHardRedirect(state);
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [qty, setQty] = useState("");

  const site = useMemo(() => sites.find((s) => s.id === siteId), [sites, siteId]);
  const entered = Number(qty);
  const valid = Number.isFinite(entered) && entered > 0;
  const after = valid && site ? Math.round((site.balance - entered) * 100) / 100 : null;
  const short = after !== null && after < 0;

  return (
    <form action={action} className="space-y-4">
      <Banner state={state} />
      <input type="hidden" name="stock_item_id" value={itemId} />
      <SiteSelect
        name="site_id"
        label="Out of"
        sites={sites}
        value={siteId}
        onChange={setSiteId}
        unit={unit}
      />
      <QtyInput name="qty" label={`How many ${unit}?`} value={qty} onChange={setQty} />
      {jobs.length > 0 ? (
        <div>
          <label htmlFor="job_id" className="block text-sm font-medium text-slate-800">
            For which job? <span className="text-xs font-normal text-slate-500">Optional</span>
          </label>
          <select
            id="job_id"
            name="job_id"
            className="mt-1.5 block w-full rounded-md border border-slate-300 bg-white px-3 py-2.5 text-base focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 sm:text-sm"
          >
            <option value="">— not job specific —</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">
            Records where it went. It adds no cost to the job — the material was costed when you
            recorded the supplier&rsquo;s bill.
          </p>
        </div>
      ) : null}
      <div>
        <label htmlFor="notes" className="block text-sm font-medium text-slate-800">
          Note <span className="text-xs font-normal text-slate-500">Optional</span>
        </label>
        <textarea
          id="notes"
          name="notes"
          rows={2}
          className="mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-base focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 sm:text-sm"
        />
      </div>
      {after !== null ? (
        <p
          className={`rounded-md px-3 py-2 text-sm ${
            short ? "bg-red-50 text-red-800" : "bg-slate-50 text-slate-700"
          }`}
        >
          {short
            ? `Only ${formatQuantity(site?.balance ?? 0)} ${unit} there — you can't issue more than you have.`
            : `${site?.name} would be left with ${formatQuantity(after)} ${unit}.`}
        </p>
      ) : null}
      <Submit pending={pending} disabled={!valid || short}>
        Issue {valid ? `${formatQuantity(entered)} ${unit}` : "stock"}
      </Submit>
    </form>
  );
}

function TransferForm({
  itemId,
  unit,
  sites,
}: {
  itemId: string;
  unit: string;
  sites: SiteOption[];
}) {
  const [state, action, pending] = useActionState(transferStock, INITIAL_FORM_STATE);
  useHardRedirect(state);
  const [fromId, setFromId] = useState(sites[0]?.id ?? "");
  const [toId, setToId] = useState(sites[1]?.id ?? sites[0]?.id ?? "");
  const [qty, setQty] = useState("");

  const from = sites.find((s) => s.id === fromId);
  const to = sites.find((s) => s.id === toId);
  const entered = Number(qty);
  const valid = Number.isFinite(entered) && entered > 0;
  const same = fromId === toId;
  const short = valid && from ? entered > from.balance : false;

  if (sites.length < 2) {
    return (
      <p className="text-sm text-slate-600">
        You need two places to move stock between.{" "}
        <Link href="/sites/new" className="font-medium text-slate-900 underline">
          Add another site
        </Link>
        .
      </p>
    );
  }

  return (
    <form action={action} className="space-y-4">
      <Banner state={state} />
      <input type="hidden" name="stock_item_id" value={itemId} />
      <SiteSelect
        name="from_site_id"
        label="From"
        sites={sites}
        value={fromId}
        onChange={setFromId}
        unit={unit}
      />
      <SiteSelect
        name="to_site_id"
        label="To"
        sites={sites}
        value={toId}
        onChange={setToId}
        unit={unit}
      />
      <QtyInput name="qty" label={`How many ${unit}?`} value={qty} onChange={setQty} />
      <div>
        <label htmlFor="transfer_notes" className="block text-sm font-medium text-slate-800">
          Note <span className="text-xs font-normal text-slate-500">Optional</span>
        </label>
        <textarea
          id="transfer_notes"
          name="notes"
          rows={2}
          className="mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-base focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 sm:text-sm"
        />
      </div>
      {same ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Pick two different places.
        </p>
      ) : short ? (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          Only {formatQuantity(from?.balance ?? 0)} {unit} at {from?.name}.
        </p>
      ) : valid && from && to ? (
        <p className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">
          {from.name} → {to.name}. Nothing is created or lost: the company still holds the same
          amount in total.
        </p>
      ) : null}
      <Submit pending={pending} disabled={!valid || same || short}>
        Move stock
      </Submit>
    </form>
  );
}

function AdjustForm({
  itemId,
  unit,
  sites,
}: {
  itemId: string;
  unit: string;
  sites: SiteOption[];
}) {
  const [state, action, pending] = useActionState(adjustStock, INITIAL_FORM_STATE);
  useHardRedirect(state);
  const [siteId, setSiteId] = useState(sites[0]?.id ?? "");
  const [counted, setCounted] = useState("");

  const site = sites.find((s) => s.id === siteId);
  const countedNum = Number(counted);
  const validCount = counted.trim() !== "" && Number.isFinite(countedNum) && countedNum >= 0;
  // The operator types WHAT THEY COUNTED; the delta is derived. Asking for a
  // signed difference at the shelf is how a "+12" becomes a "-12".
  const delta = validCount && site ? Math.round((countedNum - site.balance) * 100) / 100 : 0;

  return (
    <form action={action} className="space-y-4">
      <Banner state={state} />
      <input type="hidden" name="stock_item_id" value={itemId} />
      <input type="hidden" name="delta" value={String(delta)} />
      <SiteSelect
        name="site_id"
        label="Where did you count?"
        sites={sites}
        value={siteId}
        onChange={setSiteId}
        unit={unit}
      />
      <QtyInput
        name="counted"
        label={`How many ${unit} are actually there?`}
        value={counted}
        onChange={setCounted}
        help="Type what you counted. CrewFlow works out the difference."
      />
      <div>
        <label htmlFor="reason" className="block text-sm font-medium text-slate-800">
          Why is it different?<span className="ml-0.5 text-red-500">*</span>
        </label>
        <textarea
          id="reason"
          name="reason"
          rows={2}
          required
          placeholder="Quarterly stock-take — two bags split and binned"
          className="mt-1.5 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-base focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 sm:text-sm"
        />
        <p className="mt-1 text-xs text-slate-500">
          Required. An adjustment is the one movement with nothing behind it, so the reason is the
          only record of why the number changed.
        </p>
      </div>
      {validCount && site ? (
        <p
          className={`rounded-md px-3 py-2 text-sm ${
            delta === 0
              ? "bg-slate-50 text-slate-700"
              : delta > 0
                ? "bg-emerald-50 text-emerald-800"
                : "bg-amber-50 text-amber-800"
          }`}
        >
          {delta === 0
            ? "That matches what CrewFlow already thinks — nothing to record."
            : delta > 0
              ? `${formatQuantity(delta)} ${unit} more than expected at ${site.name}.`
              : `${formatQuantity(Math.abs(delta))} ${unit} short at ${site.name}.`}
        </p>
      ) : null}
      <Submit pending={pending} disabled={!validCount || delta === 0}>
        Record the count
      </Submit>
    </form>
  );
}

/**
 * Reverse ONE movement, in full, with a reason. The ledger is append-only, so
 * this writes a new row and both stay visible for ever — which is exactly why
 * the copy says "reverse", never "undo" or "delete".
 */
export function CorrectMovementForm({
  itemId,
  movementId,
  summary,
}: {
  itemId: string;
  movementId: string;
  summary: string;
}) {
  const [state, action, pending] = useActionState(
    correctStockMovement.bind(null, itemId),
    INITIAL_FORM_STATE,
  );
  useHardRedirect(state);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs font-medium text-slate-500 underline hover:text-slate-800"
      >
        Reverse this
      </button>
    );
  }

  return (
    <form action={action} className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <Banner state={state} />
      <input type="hidden" name="movement_id" value={movementId} />
      <p className="text-xs text-slate-600">
        Reverses {summary} in full. Both entries stay in the history — nothing is deleted.
      </p>
      <textarea
        name="reason"
        rows={2}
        required
        placeholder="Why is this being reversed?"
        className="block w-full rounded-md border border-slate-300 px-3 py-2 text-base focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500 sm:text-sm"
      />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-slate-900 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:bg-slate-300"
        >
          {pending ? "Saving…" : "Reverse"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
