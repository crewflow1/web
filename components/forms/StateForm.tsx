"use client";

import { useActionState, useEffect } from "react";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { FormErrorBanner } from "@/components/forms/Field";

/**
 * Client dispatch for FormState-returning server actions — the app-wide cure
 * for the Next 15.5 deep-swap commit race (upstream vercel/next.js#83386;
 * first shipped for fleet, commit 8e4a846).
 *
 * WHY THIS EXISTS — DO NOT SWAP BACK TO `<form action={serverAction}>` +
 * `redirect()`: a Server Action that calls `redirect()` while the route tree's
 * first differing segment sits ≥4 levels deep loses a race inside the app
 * router: the action's rejected redirect error can strand React's
 * still-suspended commit of the navigated state, so the row is written but the
 * browser stays put — silently, with no console error, no boundary, no URL
 * change. The deeper the changed segment and the more paths the action
 * revalidates, the more often the race is lost. Same-route `?saved=` redirects
 * on `[id]` pages swap even deeper (the page segment itself) and were measured
 * losing 100% of reps on permits/templates/certificates/blueprints/payments/
 * quotes under `next start`.
 *
 * The action returns `FormState` (`lib/forms/state.ts`); on `ok` +
 * `redirectTo` the client navigates with a FULL DOCUMENT LOAD — not
 * router.push, which flakes at these depths (~30-50% observed). A document
 * load has no router in the loop, renders the ?saved= banner server-side, and
 * scrolls to #anchors natively. These are rare, high-value transitions;
 * reliability beats the SPA hop.
 *
 * Children stay server-rendered — only the <form> boundary, error banner and
 * the post-success navigation live on the client.
 *
 * Known tradeoff: a pre-hydration (or JS-off) submit still runs the action but
 * re-renders in place instead of navigating (the old redirect() pattern's 303
 * did navigate there). Accepted with the fleet fix: a rare stale-looking page
 * beats a silent 60-100% loss for every hydrated user, and e2e clicks wait for
 * hydration for exactly this reason.
 */
export function StateForm({
  action,
  className,
  confirm,
  children,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  className?: string;
  /** Optional native `window.confirm()` gate — the action only runs on OK (mirrors ConfirmForm). */
  confirm?: string;
  children: React.ReactNode;
}) {
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);

  useEffect(() => {
    if (state.ok && state.redirectTo) window.location.assign(state.redirectTo);
  }, [state.ok, state.redirectTo, state.submittedAt]);

  return (
    <form
      action={formAction}
      onSubmit={
        confirm
          ? (e) => {
              if (!window.confirm(confirm)) e.preventDefault();
            }
          : undefined
      }
      className={className}
    >
      {state.error ? (
        <div className="col-span-full">
          <FormErrorBanner error={state.error} />
        </div>
      ) : null}
      {children}
    </form>
  );
}
