"use client";

import { useActionState, useEffect, useState } from "react";
import Link from "next/link";
import { useFormStatus } from "react-dom";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";
import { signInWithPassword, signUpWithPassword } from "./actions";

/**
 * Email + password auth, ADDITIVE, rendered on /login alongside the existing
 * Google + magic-link options (which are untouched).
 *
 * Two modes in one component: "Sign in" and "Create account". Both are
 * useActionState-driven so validation errors render inline and the typed email
 * is preserved. On success the action returns `redirectTo` and we navigate via
 * window.location.assign (a full-document nav, deliberately not router.push,
 * per the app's deep-swap navigation rule).
 */

type Mode = "signin" | "signup";

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-60"
    >
      {pending ? "Please wait…" : label}
    </button>
  );
}

export function EmailPasswordForm({ next }: { next?: string }) {
  const [mode, setMode] = useState<Mode>("signin");

  const [signInState, signInAction] = useActionState(
    signInWithPassword,
    INITIAL_FORM_STATE,
  );
  const [signUpState, signUpAction] = useActionState(
    signUpWithPassword,
    INITIAL_FORM_STATE,
  );

  const state: FormState = mode === "signin" ? signInState : signUpState;

  // Navigate on success (sign-in landing, or MFA challenge redirect).
  useEffect(() => {
    if (state.ok && state.redirectTo) {
      window.location.assign(state.redirectTo);
    }
  }, [state.ok, state.redirectTo, state.submittedAt]);

  const fe = state.fieldErrors ?? {};
  const emailDefault =
    typeof state.values?.email === "string" ? state.values.email : "";

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 text-sm">
        <button
          type="button"
          onClick={() => setMode("signin")}
          className={
            mode === "signin"
              ? "rounded-md bg-slate-900 px-3 py-1.5 font-semibold text-white"
              : "rounded-md border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
          }
        >
          Sign in
        </button>
        <button
          type="button"
          onClick={() => setMode("signup")}
          className={
            mode === "signup"
              ? "rounded-md bg-slate-900 px-3 py-1.5 font-semibold text-white"
              : "rounded-md border border-slate-300 px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-50"
          }
        >
          Create account
        </button>
      </div>

      {state.error ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {state.error}
        </div>
      ) : null}
      {state.ok && state.successMessage ? (
        <div
          role="status"
          className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800"
        >
          {state.successMessage}
        </div>
      ) : null}

      <form
        action={mode === "signin" ? signInAction : signUpAction}
        noValidate
        className="space-y-3"
        data-testid="password-form"
        aria-label={
          mode === "signin"
            ? "Sign in with email and password"
            : "Create an account with email and password"
        }
      >
        {next ? <input type="hidden" name="next" value={next} /> : null}

        <div>
          <label
            htmlFor="pw-email"
            className="block text-sm font-medium text-slate-700"
          >
            Email
          </label>
          <input
            id="pw-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            defaultValue={emailDefault}
            placeholder="you@yourcompany.co.uk"
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
          {fe.email ? (
            <p className="mt-1 text-xs text-red-600">{fe.email}</p>
          ) : null}
        </div>

        <div>
          <label
            htmlFor="pw-password"
            className="block text-sm font-medium text-slate-700"
          >
            Password
          </label>
          <input
            id="pw-password"
            name="password"
            type="password"
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            required
            minLength={mode === "signup" ? 8 : undefined}
            placeholder={mode === "signup" ? "At least 8 characters" : "Your password"}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
          />
          {fe.password ? (
            <p className="mt-1 text-xs text-red-600">{fe.password}</p>
          ) : null}
        </div>

        {mode === "signup" ? (
          <div>
            <label
              htmlFor="pw-confirm"
              className="block text-sm font-medium text-slate-700"
            >
              Confirm password
            </label>
            <input
              id="pw-confirm"
              name="confirm"
              type="password"
              autoComplete="new-password"
              required
              placeholder="Re-enter your password"
              className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
            />
            {fe.confirm ? (
              <p className="mt-1 text-xs text-red-600">{fe.confirm}</p>
            ) : null}
          </div>
        ) : null}

        <SubmitButton label={mode === "signin" ? "Sign in" : "Create account"} />
      </form>

      {mode === "signin" ? (
        <p className="text-center text-xs text-slate-500">
          <Link
            href="/reset-password"
            className="font-medium text-slate-700 underline"
          >
            Forgot your password?
          </Link>
        </p>
      ) : null}
    </div>
  );
}
