"use client";

import { useActionState, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { INITIAL_FORM_STATE } from "@/lib/forms/state";
import { eraseStaffMemberAction } from "../erasure-actions";

/**
 * "Remove and erase personal data" — the erasure launcher on a staff member's
 * page. Rendered only for an owner/admin, for a non-owner who is not the viewer,
 * while FEATURE_ACCOUNT_DELETION is on (the page decides; the action re-checks
 * all of it). Leaves with `window.location.assign` on success — this is a
 * force-dynamic `[id]` route.
 */
export function EraseStaffForm({
  staffUserId,
  staffEmail,
  staffLabel,
}: {
  staffUserId: string;
  staffEmail: string;
  staffLabel: string;
}) {
  const [state, action, pending] = useActionState(
    eraseStaffMemberAction.bind(null, staffUserId),
    INITIAL_FORM_STATE,
  );
  const [typed, setTyped] = useState("");
  const confirmId = useId();
  const passwordId = useId();
  useEffect(() => {
    if (state.ok && state.redirectTo) window.location.assign(state.redirectTo);
  }, [state.ok, state.redirectTo, state.submittedAt]);
  const matches = staffEmail !== "" && typed.trim().toLowerCase() === staffEmail.trim().toLowerCase();
  const input =
    "mt-1 block w-full max-w-sm rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-300";

  return (
    <form action={action} className="mt-4 space-y-4">
      <div>
        <label htmlFor={confirmId} className="block text-sm font-medium text-slate-900">
          Type {staffLabel}&apos;s email address to confirm:{" "}
          <span className="font-semibold">{staffEmail}</span>
        </label>
        <input
          id={confirmId}
          name="confirm_email"
          type="email"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
          className={input}
        />
      </div>
      <div>
        <label htmlFor={passwordId} className="block text-sm font-medium text-slate-900">
          Your password
        </label>
        <input
          id={passwordId}
          name="password"
          type="password"
          autoComplete="current-password"
          aria-describedby={`${passwordId}-hint`}
          className={input}
        />
        <p id={`${passwordId}-hint`} className="mt-1 text-xs text-slate-600">
          No password? Leave this blank — sign out, sign back in, and return here within 10 minutes.
        </p>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-red-700">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" variant="destructive" size="sm" disabled={!matches || pending}>
        {pending ? "Erasing…" : "Remove and erase personal data"}
      </Button>
    </form>
  );
}
