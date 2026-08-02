"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { INITIAL_FORM_STATE } from "@/lib/forms/state";
import { updatePassword } from "../actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-60"
    >
      {pending ? "Saving…" : "Update password"}
    </button>
  );
}

export function UpdatePasswordForm() {
  const [state, action] = useActionState(updatePassword, INITIAL_FORM_STATE);
  const fe = state.fieldErrors ?? {};

  useEffect(() => {
    if (state.ok && state.redirectTo) {
      // Brief pause so the success banner is visible, then land them in-app.
      const t = setTimeout(() => window.location.assign(state.redirectTo!), 1200);
      return () => clearTimeout(t);
    }
  }, [state.ok, state.redirectTo, state.submittedAt]);

  return (
    <form action={action} noValidate className="space-y-3">
      {state.ok && state.successMessage ? (
        <div
          role="status"
          className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800"
        >
          {state.successMessage}
        </div>
      ) : null}
      {state.error ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {state.error}
        </div>
      ) : null}

      <div>
        <label htmlFor="new-password" className="block text-sm font-medium text-slate-700">
          New password
        </label>
        <input
          id="new-password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          placeholder="At least 8 characters"
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
        {fe.password ? <p className="mt-1 text-xs text-red-600">{fe.password}</p> : null}
      </div>

      <div>
        <label htmlFor="confirm-password" className="block text-sm font-medium text-slate-700">
          Confirm new password
        </label>
        <input
          id="confirm-password"
          name="confirm"
          type="password"
          autoComplete="new-password"
          required
          placeholder="Re-enter your password"
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
        {fe.confirm ? <p className="mt-1 text-xs text-red-600">{fe.confirm}</p> : null}
      </div>

      <SubmitButton />
    </form>
  );
}
