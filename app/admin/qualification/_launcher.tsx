"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Filter, Sparkles } from "lucide-react";
import {
  qualifyCompanyAction,
  qualifyExistingCompanyAction,
  type QualificationFormState,
} from "./actions";

/**
 * Lead Qualification AI launcher (CEO Directive 003, Module 3) — the one button.
 *
 * Unlike Research AI (which can research a company from a bare name) there is
 * nothing to qualify until a company exists, so this is a CHOOSER, not a
 * free-text form: pick a researched lead still sitting at 'new' and the engine
 * makes the deterministic qualify/disqualify call. Errors surface inline via
 * useActionState; the submit shows a pending state so a double-click can't
 * double-launch. The per-row "Qualify" button uses the same idempotent path.
 */

export type LauncherCandidate = {
  id: string;
  name: string;
  score: number | null;
  researched: boolean;
};

const INITIAL: QualificationFormState = { error: null };

export function QualificationLauncher({
  candidates,
}: {
  candidates: LauncherCandidate[];
}) {
  const [state, formAction] = useActionState(qualifyCompanyAction, INITIAL);

  if (candidates.length === 0) {
    return (
      <p className="rounded-lg border border-slate-800 bg-slate-900/60 px-3.5 py-3 text-sm text-slate-400">
        No new leads waiting to be qualified. Research a company first — the
        qualifier reads the fit score Research AI produced.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-400">
          New lead to qualify
        </span>
        <div className="relative">
          <Filter
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
            aria-hidden
          />
          <select
            name="company_id"
            defaultValue=""
            className="w-full appearance-none rounded-lg border border-slate-700 bg-slate-900/80 py-2.5 pl-9 pr-3 text-sm text-white outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
          >
            <option value="" disabled>
              Choose a researched lead…
            </option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.score != null ? ` — fit ${c.score}` : " — unscored"}
                {c.researched ? "" : " (not researched)"}
              </option>
            ))}
          </select>
        </div>
      </label>

      {state.error ? (
        <p
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
        >
          {state.error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500">
          Deterministic, explainable, reversible — the engine only moves a lead
          out of &lsquo;new&rsquo; and never contacts anyone.
        </p>
        <SubmitButton />
      </div>
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-900/30 transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <Sparkles
        className={`h-4 w-4 ${pending ? "animate-pulse" : ""}`}
        aria-hidden
      />
      {pending ? "Starting qualification…" : "Qualify lead"}
    </button>
  );
}

/** One-click "Qualify" for a single candidate row — same enqueue, fast path. */
export function QuickQualifyButton({ companyId }: { companyId: string }) {
  return (
    <form action={qualifyExistingCompanyAction}>
      <input type="hidden" name="company_id" value={companyId} />
      <QuickSubmit />
    </form>
  );
}

function QuickSubmit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center gap-1.5 rounded-md border border-indigo-500/40 bg-indigo-500/10 px-2.5 py-1.5 text-xs font-semibold text-indigo-200 transition hover:bg-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <Sparkles className={`h-3.5 w-3.5 ${pending ? "animate-pulse" : ""}`} aria-hidden />
      {pending ? "Starting…" : "Qualify"}
    </button>
  );
}
