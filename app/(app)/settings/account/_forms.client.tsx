"use client";

import { useActionState, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import {
  cancelCompanyDeletionAction,
  deleteMyAccountAction,
  requestCompanyDeletionAction,
} from "./actions";

/**
 * Client forms for Settings → Account. Each posts to a server action that
 * re-checks everything (flag, session, role, re-authentication, the typed
 * confirmation). The checks here only stop an accidental click; they are not
 * the boundary.
 *
 * After a successful action the page is left with `window.location.assign`
 * (a full navigation: the session may no longer exist).
 */

const INPUT =
  "mt-1 block w-full max-w-sm rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm outline-none focus:border-slate-900 focus:ring-2 focus:ring-slate-300";

function useLeaveOnSuccess(state: FormState): void {
  useEffect(() => {
    if (state.ok && state.redirectTo) window.location.assign(state.redirectTo);
  }, [state.ok, state.redirectTo, state.submittedAt]);
}

function FormMessage({ state }: { state: FormState }) {
  if (state.error) {
    return (
      <p role="alert" className="text-sm text-red-700">
        {state.error}
      </p>
    );
  }
  if (state.ok && state.successMessage) {
    return (
      <p role="status" className="text-sm text-slate-800">
        {state.successMessage}
      </p>
    );
  }
  return null;
}

function PasswordField({ id }: { id: string }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-slate-900">
        Your password
      </label>
      <input
        id={id}
        name="password"
        type="password"
        autoComplete="current-password"
        aria-describedby={`${id}-hint`}
        className={INPUT}
      />
      <p id={`${id}-hint`} className="mt-1 text-xs text-slate-600">
        No password (you sign in with an email link or Google)? Leave this blank — sign out, sign
        back in, and return here within 10 minutes.
      </p>
    </div>
  );
}

export function DeleteAccountForm({ email }: { email: string }) {
  const [state, action, pending] = useActionState(deleteMyAccountAction, INITIAL_FORM_STATE);
  const [typed, setTyped] = useState("");
  const confirmId = useId();
  const passwordId = useId();
  useLeaveOnSuccess(state);
  const matches = typed.trim().toLowerCase() === email.trim().toLowerCase() && email !== "";

  return (
    <form action={action} className="mt-5 space-y-4 border-t border-slate-200 pt-5">
      <div>
        <label htmlFor={confirmId} className="block text-sm font-medium text-slate-900">
          Type your email address to confirm
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
          className={INPUT}
        />
      </div>
      <PasswordField id={passwordId} />
      <FormMessage state={state} />
      <Button type="submit" variant="destructive" disabled={!matches || pending}>
        {pending ? "Deleting your account…" : "Delete my account"}
      </Button>
    </form>
  );
}

export function DeleteCompanyForm({
  companyName,
  coolingOffDays,
}: {
  companyName: string;
  coolingOffDays: number;
}) {
  const [state, action, pending] = useActionState(requestCompanyDeletionAction, INITIAL_FORM_STATE);
  const [typed, setTyped] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const confirmId = useId();
  const passwordId = useId();
  const ackId = useId();
  useLeaveOnSuccess(state);
  const matches = typed.trim() === companyName.trim();

  return (
    <form action={action} className="mt-5 space-y-4 border-t border-slate-200 pt-5">
      <div className="flex items-start gap-2">
        <input
          id={ackId}
          name="acknowledge"
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="mt-1 h-4 w-4 rounded border-slate-400"
        />
        <label htmlFor={ackId} className="text-sm text-slate-800">
          I understand that in {coolingOffDays} days this permanently deletes {companyName} and all
          of its data for everyone, and that it cannot be undone.
        </label>
      </div>
      <div>
        <label htmlFor={confirmId} className="block text-sm font-medium text-slate-900">
          Type the company name to confirm:{" "}
          <span className="font-semibold">{companyName}</span>
        </label>
        <input
          id={confirmId}
          name="confirm_name"
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          required
          className={INPUT}
        />
      </div>
      <PasswordField id={passwordId} />
      <FormMessage state={state} />
      <Button type="submit" variant="destructive" disabled={!matches || !acknowledged || pending}>
        {pending ? "Scheduling…" : `Schedule deletion of ${companyName}`}
      </Button>
    </form>
  );
}

export function CancelCompanyDeletionForm() {
  const [state, action, pending] = useActionState(cancelCompanyDeletionAction, INITIAL_FORM_STATE);
  useLeaveOnSuccess(state);
  return (
    <form action={action} className="mt-4 space-y-2">
      <FormMessage state={state} />
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Cancelling…" : "Cancel the deletion"}
      </Button>
    </form>
  );
}
