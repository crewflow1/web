"use client";

import { useActionState, useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { INITIAL_FORM_STATE } from "@/lib/forms/state";
import { challengeMfa, redeemRecoveryCode } from "../../actions";

function SubmitButton({ idle, busy }: { idle: string; busy: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-60"
    >
      {pending ? busy : idle}
    </button>
  );
}

export function MfaChallengeForm({ next }: { next?: string }) {
  const [state, action] = useActionState(challengeMfa, INITIAL_FORM_STATE);
  const [recoveryState, recoveryAction] = useActionState(
    redeemRecoveryCode,
    INITIAL_FORM_STATE,
  );
  const [useRecovery, setUseRecovery] = useState(false);

  useEffect(() => {
    if (state.ok && state.redirectTo) {
      window.location.assign(state.redirectTo);
    }
  }, [state.ok, state.redirectTo, state.submittedAt]);

  useEffect(() => {
    if (recoveryState.ok && recoveryState.redirectTo) {
      window.location.assign(recoveryState.redirectTo);
    }
  }, [recoveryState.ok, recoveryState.redirectTo, recoveryState.submittedAt]);

  const fe = state.fieldErrors ?? {};
  const rfe = recoveryState.fieldErrors ?? {};

  if (useRecovery) {
    return (
      <div className="space-y-3">
        <form action={recoveryAction} noValidate className="space-y-3">
          {next ? <input type="hidden" name="next" value={next} /> : null}

          {recoveryState.error ? (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
            >
              {recoveryState.error}
            </div>
          ) : null}

          <div>
            <label
              htmlFor="recovery-code"
              className="block text-sm font-medium text-slate-700"
            >
              Recovery code
            </label>
            <input
              id="recovery-code"
              name="code"
              type="text"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={32}
              required
              autoFocus
              placeholder="XXXXX-XXXXX"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-center text-lg tracking-[0.2em] uppercase placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
            {rfe.code ? <p className="mt-1 text-xs text-red-600">{rfe.code}</p> : null}
          </div>

          <p className="text-xs text-slate-500">
            Using a recovery code turns off two-factor authentication so you can
            sign in. Set it up again from Security once you&apos;re back in.
          </p>

          <SubmitButton idle="Use recovery code" busy="Verifying…" />
        </form>

        <button
          type="button"
          onClick={() => setUseRecovery(false)}
          className="w-full text-center text-sm text-slate-500 hover:underline"
        >
          Back to authenticator code
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
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

        <SubmitButton idle="Verify" busy="Verifying…" />
      </form>

      <button
        type="button"
        onClick={() => setUseRecovery(true)}
        className="w-full text-center text-sm text-slate-500 hover:underline"
      >
        Lost your device? Use a recovery code
      </button>
    </div>
  );
}
