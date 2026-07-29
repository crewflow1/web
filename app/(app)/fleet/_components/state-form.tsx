"use client";

import { useActionState, useEffect } from "react";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { FormErrorBanner } from "@/components/forms/Field";

/**
 * Client dispatch for fleet's small inline forms (compliance, fuel, delete).
 *
 * WHY THIS EXISTS — DO NOT SWAP BACK TO `<form action={serverAction}>` +
 * `redirect()`: a Server Action that calls `redirect()` between two routes
 * under /fleet/vehicles/* loses a race inside the app router (Next 15.5): the
 * action's rejected redirect error can strand React's still-suspended commit
 * of the navigated state, so the row is written but the browser stays put —
 * silently, with no console error. The deeper the changed segment and the more
 * paths the action revalidates, the more often the race is lost; every fleet
 * flow sits on the losing side. Returning `FormState.redirectTo` and letting
 * the client `router.push` is the same pattern the customers/suppliers forms
 * use, and a plain navigation never enters the racy code path.
 *
 * Children stay server-rendered — only the <form> boundary, error banner and
 * the post-success navigation live on the client.
 */
export function StateForm({
  action,
  className,
  children,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  className?: string;
  children: React.ReactNode;
}) {
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);

  useEffect(() => {
    // Full document navigation ON PURPOSE — not router.push. Client-side
    // navigations between routes this deep hit the same stranded-commit race
    // as Server-Action redirects (observed directly: the target RSC fetch
    // completes and the URL never changes). A document load has no router in
    // the loop, renders the ?saved= banner server-side, and scrolls to
    // #anchors natively. These are rare, high-value transitions; reliability
    // beats the SPA hop.
    if (state.ok && state.redirectTo) window.location.assign(state.redirectTo);
  }, [state.ok, state.redirectTo, state.submittedAt]);

  return (
    <form action={formAction} className={className}>
      {state.error ? (
        <div className="col-span-full">
          <FormErrorBanner error={state.error} />
        </div>
      ) : null}
      {children}
    </form>
  );
}
