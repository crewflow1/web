"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Mail, Sparkles } from "lucide-react";
import {
  draftOutreachAction,
  draftOutreachForCompanyAction,
  type OutreachFormState,
} from "./actions";

/**
 * Outreach AI launcher (CEO Directive 010, Phase 4) — the one button.
 *
 * Like Lead Qualification AI (and unlike Research AI) there is nothing to
 * draft until a company exists and has been qualified, so this is a CHOOSER:
 * pick a qualified company and the engine drafts the cold outreach email as an
 * immutable artifact awaiting human review. Errors surface inline via
 * useActionState; the submit shows a pending state so a double-click can't
 * double-launch (the queue claim is atomic anyway).
 */

export type OutreachCandidate = {
  id: string;
  name: string;
  score: number | null;
  researched: boolean;
};

const INITIAL: OutreachFormState = { error: null };

export function OutreachLauncher({ candidates }: { candidates: OutreachCandidate[] }) {
  const [state, formAction] = useActionState(draftOutreachAction, INITIAL);

  if (candidates.length === 0) {
    return (
      <p className="rounded-lg border border-slate-800 bg-slate-900/60 px-3.5 py-3 text-sm text-slate-400">
        No qualified companies waiting for outreach. Qualify a lead first — the
        drafter grounds its email on the research and the qualification verdict.
      </p>
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <label className="block">
        <span className="mb-1 block text-xs font-medium text-slate-400">
          Qualified company to draft outreach for
        </span>
        <div className="relative">
          <Mail
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
            aria-hidden
          />
          <select
            name="company_id"
            defaultValue=""
            className="w-full appearance-none rounded-lg border border-slate-700 bg-slate-900/80 py-2.5 pl-9 pr-3 text-sm text-white outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
          >
            <option value="" disabled>
              Choose a qualified company…
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

      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center gap-2 rounded-lg bg-indigo-500 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-500/20 transition hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <Sparkles className="h-4 w-4" aria-hidden />
      {pending ? "Drafting…" : "Draft outreach"}
    </button>
  );
}

/** Per-row one-click launcher for the qualified-companies list. */
export function QuickDraftButton({ companyId }: { companyId: string }) {
  return (
    <form action={draftOutreachForCompanyAction}>
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
      className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {pending ? "Drafting…" : "Draft outreach"}
    </button>
  );
}
