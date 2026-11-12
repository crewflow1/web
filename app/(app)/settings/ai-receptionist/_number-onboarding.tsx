"use client";

import { useActionState, useState, useTransition } from "react";
import { FormShell, SubmitButton } from "@/components/forms/FormShell";
import { Field, SelectField } from "../../_components/field";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import type { AvailableNumber, NumberPricing, UkNumberType } from "@/lib/telephony/provisioning";
import type { NumberSearchResult } from "./number-actions";

/**
 * Phone-number ONBOARDING (Twilio receptionist PR 5) — keep your number
 * (Option A) or get a new CrewFlow number (Option B). Product/light theme,
 * mobile-first. Honest when Twilio isn't connected yet: the search is empty and
 * requests are captured as intent, never implied as a completed purchase.
 */

type Values = Record<string, unknown>;
type ActionFn = (prev: FormState<Values>, formData: FormData) => Promise<FormState<Values>>;
type SearchFn = (formData: FormData) => Promise<NumberSearchResult>;

export type CurrentNumber = {
  e164: string;
  number_type: string | null;
  active: boolean;
  onboarding_mode: string | null;
  forwarding_from: string | null;
  monthly_cost_pence: number | null;
};

function penceToGbp(pence: number | null | undefined): string | null {
  if (pence == null || !Number.isFinite(pence)) return null;
  return `£${(pence / 100).toFixed(2)}/mo`;
}

const TYPE_LABELS: Record<string, string> = {
  local: "Local (geographic)",
  national: "National (+44 3xx)",
  mobile: "Mobile",
  tollfree: "Freephone",
  forwarding: "Forwarding receiver",
};

function Card({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">{children}</div>;
}

/** The current active number, when the org already has one. */
function CurrentNumberView({ number }: { number: CurrentNumber }) {
  const cost = penceToGbp(number.monthly_cost_pence);
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Your CrewFlow number</h3>
          <p className="mt-1 font-mono text-lg text-slate-900">{number.e164}</p>
          <p className="mt-1 text-xs text-slate-600">
            {TYPE_LABELS[number.number_type ?? ""] ?? "Number"}
            {cost ? ` · ${cost}` : ""}
            {number.onboarding_mode === "existing_number_forward" && number.forwarding_from
              ? ` · forwards from ${number.forwarding_from}`
              : ""}
          </p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-3 py-1 text-xs font-medium ${
            number.active ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"
          }`}
        >
          {number.active ? "Active" : "Inactive"}
        </span>
      </div>
      {number.onboarding_mode === "existing_number_forward" ? (
        <p className="mt-3 rounded-md bg-slate-50 p-3 text-xs text-slate-600">
          Calls to your business line forward to this number, where the AI receptionist answers.
          To change or stop forwarding, update the divert on your original line with your carrier.
        </p>
      ) : null}
    </Card>
  );
}

/** Carrier forwarding codes for Option A, parameterised by the receiving number. */
function ForwardingInstructions({ receiver }: { receiver: string }) {
  const n = receiver || "<your CrewFlow number>";
  return (
    <div className="mt-4 space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
      <p className="font-medium text-slate-900">Forward your line to {n}</p>
      <p>
        Dial these from the handset of the line you&rsquo;re forwarding. Exact codes vary by
        carrier — check with your provider if one doesn&rsquo;t work.
      </p>
      <ul className="space-y-1">
        <li>
          <span className="font-medium">Recommended (only when you don&rsquo;t pick up):</span>
          <br />
          No answer <code className="rounded bg-white px-1">*61*{n}#</code> · Busy{" "}
          <code className="rounded bg-white px-1">*67*{n}#</code> · Unreachable{" "}
          <code className="rounded bg-white px-1">*62*{n}#</code>
        </li>
        <li>
          <span className="font-medium">All calls:</span>{" "}
          <code className="rounded bg-white px-1">*21*{n}#</code> (cancel{" "}
          <code className="rounded bg-white px-1">#21#</code>)
        </li>
        <li>
          Cancel all diverts: <code className="rounded bg-white px-1">##002#</code>
        </li>
      </ul>
    </div>
  );
}

/** Option A — keep your number. */
function KeepNumberPanel({ action }: { action: ActionFn }) {
  const [state, formAction, pending] = useActionState<FormState<Values>, FormData>(
    action,
    INITIAL_FORM_STATE,
  );
  const fe = state.fieldErrors ?? {};
  const receiver = (state.ok && (state.values?.receiver as string | undefined)) || "";

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">
        Keep the number your customers already know. We provision a dedicated CrewFlow receiving
        number and you forward your line to it, so calls land in the right account.
      </p>
      <FormShell state={state} action={formAction} className="space-y-4">
        <Field
          name="forwarding_from"
          label="Your current business number"
          type="tel"
          required
          placeholder="+44 ..."
          error={fe.forwarding_from}
          help="International format, e.g. +447700900123."
        />
        <SubmitButton pending={pending}>Set up forwarding</SubmitButton>
      </FormShell>
      {state.ok ? <ForwardingInstructions receiver={receiver} /> : null}
    </div>
  );
}

/** Option B — get a new number. */
function GetNumberPanel({
  search,
  requestAction,
}: {
  search: SearchFn;
  requestAction: ActionFn;
}) {
  const [results, setResults] = useState<AvailableNumber[] | null>(null);
  const [pricing, setPricing] = useState<NumberPricing | null>(null);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [reqState, reqAction, reqPending] = useActionState<FormState<Values>, FormData>(
    requestAction,
    INITIAL_FORM_STATE,
  );

  function onSearch(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      setSearchErr(null);
      const res = await search(fd);
      if (!res.ok) {
        setSearchErr(res.error ?? "Search failed.");
        setResults([]);
        return;
      }
      setResults(res.numbers);
      setPricing(res.pricing);
    });
  }

  function priceFor(type: UkNumberType): number | null {
    return pricing?.monthlyPence?.[type] ?? null;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Get a brand-new UK number wired straight to the AI receptionist.
      </p>
      <form onSubmit={onSearch} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <SelectField
            name="type"
            label="Number type"
            options={[
              { value: "local", label: "Local (geographic)" },
              { value: "national", label: "National (+44 3xx)" },
            ]}
            defaultValue="local"
          />
          <Field name="area_code" label="Area code" optional placeholder="e.g. 28 (Belfast)" />
          <Field name="contains" label="Contains digits" optional placeholder="e.g. 7777" />
        </div>
        <SubmitButton pending={pending}>Search numbers</SubmitButton>
      </form>

      {searchErr ? (
        <p role="alert" className="text-sm text-red-700">
          {searchErr}
        </p>
      ) : null}

      {results && results.length === 0 && !searchErr ? (
        <div className="rounded-md border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
          <p className="font-medium">No numbers to show yet.</p>
          <p className="mt-1 text-xs text-sky-800">
            Connecting Twilio is a one-time founder step. Once it&rsquo;s connected you&rsquo;ll be
            able to search and buy numbers right here.
          </p>
        </div>
      ) : null}

      {reqState.error ? (
        <p role="alert" className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">
          {reqState.error}
        </p>
      ) : null}
      {reqState.ok && reqState.successMessage ? (
        <p className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-900">
          {reqState.successMessage}
        </p>
      ) : null}

      {results && results.length > 0 ? (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-200">
          {results.map((num) => {
            const cost = penceToGbp(priceFor(num.type));
            return (
              <li
                key={num.e164}
                className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-mono text-sm text-slate-900">{num.e164}</p>
                  <p className="text-xs text-slate-600">
                    {[num.locality, num.region].filter(Boolean).join(", ") || TYPE_LABELS[num.type]}
                    {cost ? ` · ${cost}` : ""}
                  </p>
                </div>
                <form action={reqAction}>
                  <input type="hidden" name="e164" value={num.e164} />
                  <input type="hidden" name="type" value={num.type} />
                  <input type="hidden" name="monthly_cost_pence" value={priceFor(num.type) ?? ""} />
                  <SubmitButton pending={reqPending}>Request this number</SubmitButton>
                </form>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

export function NumberOnboarding({
  currentNumber,
  isAdmin,
  searchAction,
  requestNewNumberAction,
  setupForwardingAction,
}: {
  currentNumber: CurrentNumber | null;
  isAdmin: boolean;
  searchAction: SearchFn;
  requestNewNumberAction: ActionFn;
  setupForwardingAction: ActionFn;
}) {
  const [tab, setTab] = useState<"keep" | "new">("keep");

  if (currentNumber) return <CurrentNumberView number={currentNumber} />;

  return (
    <Card>
      <h3 className="text-sm font-semibold text-slate-900">Phone number</h3>
      <p className="mt-0.5 text-xs text-slate-600">
        Give the AI receptionist a number to answer — keep your existing one or get a new one.
      </p>

      {!isAdmin ? (
        <p className="mt-4 rounded-md bg-slate-50 p-3 text-sm text-slate-600">
          Only owners and admins can set up the phone number.
        </p>
      ) : (
        <>
          <div className="mt-4 inline-flex rounded-md border border-slate-200 p-0.5">
            <button
              type="button"
              onClick={() => setTab("keep")}
              className={`rounded px-3 py-1.5 text-sm font-medium ${
                tab === "keep" ? "bg-slate-900 text-white" : "text-slate-700 hover:text-slate-900"
              }`}
            >
              Keep my number
            </button>
            <button
              type="button"
              onClick={() => setTab("new")}
              className={`rounded px-3 py-1.5 text-sm font-medium ${
                tab === "new" ? "bg-slate-900 text-white" : "text-slate-700 hover:text-slate-900"
              }`}
            >
              Get a new number
            </button>
          </div>

          <div className="mt-4">
            {tab === "keep" ? (
              <KeepNumberPanel action={setupForwardingAction} />
            ) : (
              <GetNumberPanel search={searchAction} requestAction={requestNewNumberAction} />
            )}
          </div>
        </>
      )}
    </Card>
  );
}
