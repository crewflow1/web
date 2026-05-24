import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrgContext } from "@/server/auth/session";
import { buildOnboardingSnapshot } from "@/server/services/onboarding-snapshot";
import {
  CHECKLIST_STEPS,
  CHECKLIST_STEP_ORDER,
  computeProgress,
  nextRecommendedAction,
  type ChecklistStep,
  type ChecklistStepId,
} from "@/lib/onboarding/checklist";
import { markStarted, skipStep, unskipStep } from "./actions";

/**
 * /onboarding/setup — guided setup walkthrough.
 *
 * This is a coordinator page, not a re-implementation of every form.
 * Each step's CTA deep-links into the existing destination (settings,
 * customers/new, quotes/new, imports, …). When the operator comes
 * back, the page recomputes from live DB state and advances.
 *
 * Auto-save: every step's data is saved by the destination's own
 * server action (already in place). This page never owns data.
 *
 * Resume-where-left-off: progress is derived from DB state, so the
 * user can quit and rejoin from any device.
 *
 * The page is HTML-only — no client JS. Mobile responsive via the
 * same Tailwind container patterns used by /dashboard and /settings.
 */

export const dynamic = "force-dynamic";

type SP = Promise<{ saved?: string; error?: string }>;

export default async function OnboardingSetupPage({
  searchParams,
}: {
  searchParams: SP;
}) {
  const { ctx } = await requireOrgContext();
  const sp = await searchParams;

  // Best-effort stamp of started_at on first visit. Idempotent.
  // Errors are swallowed so a transient DB blip doesn't break the page.
  try {
    await markStarted();
  } catch {
    /* noop */
  }

  const snap = await buildOnboardingSnapshot(ctx.org.id);
  const progress = computeProgress(snap);
  const next = nextRecommendedAction(snap);

  // 100% → bounce to the celebration screen. The complete page is
  // server-rendered + stamps `completed_at` idempotently.
  if (progress.pct === 100) {
    redirect("/onboarding/setup/complete");
  }

  // Build a stable view-list ordered by CHECKLIST_STEP_ORDER, with
  // completion + skip + "is the recommended next" flags merged in.
  const byId = new Map<ChecklistStepId, ChecklistStep>(
    CHECKLIST_STEPS.map((s) => [s.id, s] as const),
  );
  const items = CHECKLIST_STEP_ORDER.flatMap((id) => {
    const step = byId.get(id);
    if (!step) return [];
    return [
      {
        step,
        complete: progress.steps.find((p) => p.step.id === id)?.complete ?? false,
        dismissed: snap.dismissed.has(id),
        isNext: next?.id === id,
      },
    ];
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 pb-12 sm:px-0">
      <header className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          Set up CrewFlow
        </p>
        <h1 className="text-2xl font-bold text-slate-900 sm:text-3xl">
          Get your account ready for work
        </h1>
        <p className="max-w-2xl text-sm text-slate-600">
          A short, save-as-you-go setup. Leave any time — when you come
          back we&apos;ll pick up where you left off.
        </p>
      </header>

      {sp.saved === "skipped" ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Step skipped — you can bring it back any time below.
        </div>
      ) : null}
      {sp.saved === "unskipped" ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          Step restored.
        </div>
      ) : null}
      {sp.error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
          {sp.error}
        </div>
      ) : null}

      {/* Progress card ----------------------------------------------- */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-900">
            {progress.pct}% complete
          </h2>
          <p className="text-xs text-slate-500">
            {progress.done} of {progress.total} steps done
          </p>
        </div>
        <div
          className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100"
          aria-hidden
        >
          <div
            className="h-full rounded-full bg-slate-900 transition-all"
            style={{ width: `${progress.pct}%` }}
          />
        </div>

        {next ? (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Next step
              </p>
              <p className="mt-0.5 text-sm font-semibold text-slate-900">
                {next.title}
              </p>
              <p className="mt-1 text-xs text-slate-600">{next.description}</p>
            </div>
            <Link
              href={next.cta.href}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800"
            >
              {next.cta.label} →
            </Link>
          </div>
        ) : null}
      </section>

      {/* Step list --------------------------------------------------- */}
      <section className="space-y-2">
        <h2 className="px-1 text-sm font-semibold uppercase tracking-wider text-slate-500">
          All steps
        </h2>
        <ul className="space-y-2">
          {items.map(({ step, complete, dismissed, isNext }) => (
            <li
              key={step.id}
              className={`rounded-xl border bg-white p-4 shadow-sm transition sm:p-5 ${
                isNext
                  ? "border-slate-900 ring-1 ring-slate-900"
                  : complete
                    ? "border-emerald-200"
                    : dismissed
                      ? "border-slate-200 opacity-70"
                      : "border-slate-200"
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <StepStatusBadge
                      complete={complete}
                      dismissed={dismissed}
                      isNext={isNext}
                    />
                    <h3 className="text-sm font-semibold text-slate-900">
                      {step.title}
                    </h3>
                    {!step.required ? (
                      <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600">
                        Optional
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1.5 text-xs text-slate-600">
                    {step.description}
                  </p>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {!complete ? (
                    <>
                      <Link
                        href={step.cta.href}
                        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50"
                      >
                        {step.cta.label} →
                      </Link>
                      {!step.required && !dismissed ? (
                        <form action={skipStep}>
                          <input type="hidden" name="step_id" value={step.id} />
                          <button
                            type="submit"
                            className="rounded-md px-2 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-800"
                          >
                            Skip for now
                          </button>
                        </form>
                      ) : null}
                      {dismissed ? (
                        <form action={unskipStep}>
                          <input type="hidden" name="step_id" value={step.id} />
                          <button
                            type="submit"
                            className="rounded-md px-2 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-800"
                          >
                            Bring back
                          </button>
                        </form>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-xs font-medium text-emerald-700">
                      Done
                    </span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 text-xs text-slate-500">
        <Link href="/dashboard" className="hover:text-slate-900">
          ← Back to dashboard
        </Link>
        <span>
          Your progress saves automatically. Close this tab any time.
        </span>
      </div>
    </div>
  );
}

function StepStatusBadge({
  complete,
  dismissed,
  isNext,
}: {
  complete: boolean;
  dismissed: boolean;
  isNext: boolean;
}) {
  if (complete) {
    return (
      <span
        aria-label="Complete"
        className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-100 text-[11px] font-bold text-emerald-700"
      >
        ✓
      </span>
    );
  }
  if (isNext) {
    return (
      <span
        aria-label="Next step"
        className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-slate-900 text-[11px] font-bold text-white"
      >
        →
      </span>
    );
  }
  if (dismissed) {
    return (
      <span
        aria-label="Skipped"
        className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-slate-100 text-[11px] font-medium text-slate-500"
      >
        ·
      </span>
    );
  }
  return (
    <span
      aria-label="To do"
      className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 text-[11px] font-medium text-slate-500"
    >
      ○
    </span>
  );
}
