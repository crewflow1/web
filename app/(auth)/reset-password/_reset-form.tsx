"use client";

import { useActionState } from "react";
import Link from "next/link";
import { useFormStatus } from "react-dom";
import { INITIAL_FORM_STATE } from "@/lib/forms/state";
import { requestPasswordReset } from "../actions";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-60"
    >
      {pending ? "Sending…" : "Send reset link"}
    </button>
  );
}

export function ResetForm() {
  const [state, action] = useActionState(requestPasswordReset, INITIAL_FORM_STATE);
  const fe = state.fieldErrors ?? {};
  const emailDefault =
    typeof state.values?.email === "string" ? state.values.email : "";

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
        <label htmlFor="reset-email" className="block text-sm font-medium text-slate-700">
          Email
        </label>
        <input
          id="reset-email"
          name="email"
          type="email"
          autoComplete="email"
          required
          defaultValue={emailDefault}
          placeholder="you@yourcompany.co.uk"
          className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2.5 text-sm placeholder:text-slate-400 focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
        />
        {fe.email ? <p className="mt-1 text-xs text-red-600">{fe.email}</p> : null}
      </div>

      <SubmitButton />

      <p className="text-center text-xs text-slate-500">
        <Link href="/login" className="font-medium text-slate-700 underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}
