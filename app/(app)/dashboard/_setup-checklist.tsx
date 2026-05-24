import Link from "next/link";
import {
  computeProgress,
  nextRecommendedAction,
  type OnboardingSnapshot,
} from "@/lib/onboarding/checklist";
import { dismissChecklistStep } from "./_dismiss-step";

/**
 * Setup checklist card — pinned to the top of /dashboard until the
 * org's onboarding is 100% done. Directive Part 3:
 *
 *   "Dashboard should show onboarding progress: Setup 6/10 complete"
 *
 * Each step shows a CTA that takes the operator to the exact page
 * they need. Optional steps have a 'Skip' button that writes into
 * organizations.onboarding_state.dismissed_steps[] so the row drops
 * out of the visible list (but can be re-surfaced if the operator
 * later does the thing).
 *
 * The card hides itself once `showChecklist` is false — i.e. every
 * required + non-dismissed-optional step is complete.
 */
export function SetupChecklist({ snapshot }: { snapshot: OnboardingSnapshot }) {
  const progress = computeProgress(snapshot);
  if (!progress.showChecklist) return null;
  const recommended = nextRecommendedAction(snapshot);

  return (
    <section className="rounded-xl border border-amber-200 bg-amber-50/50 p-5 shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            Finish setting up CrewFlow
          </h2>
          <p className="mt-0.5 text-sm text-slate-700">
            <strong>{progress.done} of {progress.total}</strong> complete · pick
            up where you left off.
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-slate-900">
            {progress.pct}%
          </div>
          <div className="text-[11px] uppercase tracking-wide text-slate-500">
            setup
          </div>
        </div>
      </header>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-amber-100">
        <div
          className="h-full rounded-full bg-emerald-500 transition-all"
          style={{ width: `${progress.pct}%` }}
          aria-label={`Setup ${progress.pct}% complete`}
        />
      </div>

      {/* Retention hook — single primary CTA above the list pointing to
          the guided stepper. nextRecommendedAction() names the literal
          next step ("You haven't created your first quote") so the
          operator knows exactly what's waiting. */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-slate-900">
            {recommended
              ? `You're ${progress.pct}% complete — next: ${recommended.title.toLowerCase()}.`
              : "Almost there — finish the remaining optional steps."}
          </p>
          <p className="mt-0.5 text-xs text-slate-600">
            Continue in the guided stepper. Progress saves automatically.
          </p>
        </div>
        <Link
          href="/onboarding/setup"
          className="shrink-0 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
        >
          Continue setup →
        </Link>
      </div>

      <ol className="mt-5 space-y-2">
        {progress.steps.map(({ step, complete }) => (
          <li
            key={step.id}
            className="flex flex-wrap items-start gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3"
          >
            <div className="mt-0.5 shrink-0">
              {complete ? (
                <span
                  aria-label="Done"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-emerald-100 text-sm font-semibold text-emerald-700"
                >
                  ✓
                </span>
              ) : (
                <span
                  aria-label="Not done"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-slate-300 bg-white text-xs text-slate-400"
                >
                  ○
                </span>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p
                className={`text-sm font-semibold ${
                  complete ? "text-slate-500 line-through" : "text-slate-900"
                }`}
              >
                {step.title}
                {step.required ? null : (
                  <span className="ml-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                    Optional
                  </span>
                )}
              </p>
              <p className="mt-0.5 text-xs text-slate-600">
                {step.description}
              </p>
            </div>
            {complete ? null : (
              <div className="flex shrink-0 items-center gap-2">
                <Link
                  href={step.cta.href}
                  className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-slate-800"
                >
                  {step.cta.label}
                </Link>
                {!step.required ? (
                  <form action={dismissChecklistStep}>
                    <input type="hidden" name="step_id" value={step.id} />
                    <button
                      type="submit"
                      className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[11px] font-medium text-slate-600 transition hover:bg-slate-50"
                      title="Hide this step — you can still come back to it later"
                    >
                      Skip
                    </button>
                  </form>
                ) : null}
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
