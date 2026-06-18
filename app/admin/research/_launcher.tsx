"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Globe, Hash, Search, Sparkles } from "lucide-react";
import { researchCompanyAction, type ResearchFormState } from "./actions";

/**
 * Research AI launcher (CEO Directive 005, Phase 1) — the one button.
 *
 * A single form that accepts the directive's allowed inputs (company name,
 * website, Companies House number). On submit it enqueues a research task and
 * the action redirects to the live run view, where the operator watches the
 * AI work. Errors surface inline via useActionState; the submit button shows a
 * pending state so a double-click can't double-launch.
 */

const INITIAL: ResearchFormState = { error: null };

export function ResearchLauncher() {
  const [state, formAction] = useActionState(researchCompanyAction, INITIAL);

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-xs font-medium text-slate-400">
            Company name
          </span>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
              aria-hidden
            />
            <input
              name="name"
              type="text"
              autoComplete="off"
              placeholder="e.g. Pennine Groundworks Ltd"
              className="w-full rounded-lg border border-slate-700 bg-slate-900/80 py-2.5 pl-9 pr-3 text-sm text-white placeholder:text-slate-600 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
            />
          </div>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-400">
            Website
          </span>
          <div className="relative">
            <Globe
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
              aria-hidden
            />
            <input
              name="website"
              type="text"
              inputMode="url"
              autoComplete="off"
              placeholder="company.co.uk"
              className="w-full rounded-lg border border-slate-700 bg-slate-900/80 py-2.5 pl-9 pr-3 text-sm text-white placeholder:text-slate-600 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
            />
          </div>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-400">
            Companies House no.{" "}
            <span className="text-slate-600">(optional)</span>
          </span>
          <div className="relative">
            <Hash
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500"
              aria-hidden
            />
            <input
              name="companies_house_number"
              type="text"
              autoComplete="off"
              placeholder="08123456"
              className="w-full rounded-lg border border-slate-700 bg-slate-900/80 py-2.5 pl-9 pr-3 text-sm text-white placeholder:text-slate-600 outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/30"
            />
          </div>
        </label>
      </div>

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
          Research AI reads public sources only and drafts outreach for your
          review — it never contacts anyone.
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
      {pending ? "Starting research…" : "Research company"}
    </button>
  );
}
