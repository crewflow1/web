"use client";

import { useActionState } from "react";
import { buttonClass } from "@/components/ui/button";
import {
  requestReactivationAction,
  type ReactivationFormState,
} from "@/app/account/billing/actions";

/**
 * Ask to reactivate a cancelled workspace.
 *
 * Self-serve signup is off, so reactivation is a request: it alerts the CrewFlow
 * team, who send a new subscription checkout. The copy says exactly that — it
 * does not pretend the workspace comes back at the click of a button.
 */
export function ReactivationRequest({
  orgId,
  alreadyRequested,
}: {
  orgId: string;
  alreadyRequested: boolean;
}) {
  const [state, formAction, pending] = useActionState<ReactivationFormState, FormData>(
    requestReactivationAction,
    { status: "idle" },
  );
  const requested = alreadyRequested || state.status === "requested";

  if (requested) {
    return (
      <p role="status" className="text-sm text-slate-700">
        We&apos;ve got your request. We&apos;ll email you a link to restart your subscription.
        We aim to reply within one UK business day.
      </p>
    );
  }

  return (
    <form action={formAction}>
      <input type="hidden" name="expected_org_id" value={orgId} />
      <button type="submit" disabled={pending} className={buttonClass("primary", "md")}>
        {pending ? "Sending…" : "Ask to reactivate"}
      </button>
      {state.status === "error" ? (
        <p role="alert" className="mt-2 text-sm text-red-800">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}
