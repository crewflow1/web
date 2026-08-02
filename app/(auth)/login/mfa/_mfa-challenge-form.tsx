"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { INITIAL_FORM_STATE } from "@/lib/forms/state";
import { challengeMfa } from "../../actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-60"
    >
      {pending ? "Verifying…" : "Verify"}
    </button>
  );
}

export function MfaChallengeForm({ next }: { next?: string }) {
  const [state, action] = useActionState(challengeMfa, INITIAL_FORM_STATE);

  useEffect(() => {
    if (state.ok && state.redirectTo) {
      window.location.assign(state.redirectTo);
    }
  }, [state.ok, state.redirectTo, state.submittedAt]);

  const fe = state.fieldErrors ?? {};

  return (
    <form action={action} noValidate className="space-y-3">
      {next ? <input type="hidden" name="next" value={next} /> : null}

      {state.error ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {state.error}
        </div>
      ) : null}

      <div>
        <label htmlFor="mfa-code" className="block text-sm font-medium text-slate-700">
          6-digit code
        </label>
        <input
          id="mfa-code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
          required
          autoFocus
          placeholder="123456"
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-center text-lg tracking-[0.3em] placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
        {fe.code ? <p className="mt-1 text-xs text-red-600">{fe.code}</p> : null}
      </div>

      <SubmitButton />
    </form>
  );
}
