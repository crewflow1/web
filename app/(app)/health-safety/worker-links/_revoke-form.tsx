"use client";

import { useActionState, useEffect } from "react";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";

/**
 * Revoke a worker link. Returns FormState + navigates via
 * window.location.assign (not redirect()) — the same reliability pattern the
 * fleet/site-compliance forms use to sidestep the Next 15.5 deep-swap commit
 * race on same-route mutations.
 */
export function RevokeForm({
  action,
  tokenId,
}: {
  action: (prev: FormState, formData: FormData) => Promise<FormState>;
  tokenId: string;
}) {
  const [state, formAction] = useActionState(action, INITIAL_FORM_STATE);

  useEffect(() => {
    if (state.ok && state.redirectTo) window.location.assign(state.redirectTo);
  }, [state.ok, state.redirectTo, state.submittedAt]);

  return (
    <form action={formAction}>
      <input type="hidden" name="tokenId" value={tokenId} />
      <button
        type="submit"
        className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
      >
        Revoke
      </button>
      {state.error ? <p className="mt-1 text-xs text-red-600">{state.error}</p> : null}
    </form>
  );
}
