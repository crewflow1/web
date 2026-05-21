"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { FormErrorBanner, FormSuccessBanner } from "./Field";
import type { FormState } from "@/lib/forms/state";

/**
 * Wrapper that:
 *   - Renders the form-level error banner
 *   - Renders the success banner
 *   - Handles client-side navigation when the action returns `redirectTo`
 *   - Refreshes the router so server-rendered lists pick up new rows
 *
 * Composes with any `useActionState`-driven form. Pass the `state` from
 * useActionState and your form `action`, and put your fields inside as
 * children.
 *
 * Usage:
 *   const [state, action, pending] = useActionState(createCustomer, INITIAL_FORM_STATE);
 *   return (
 *     <FormShell state={state} action={action}>
 *       <Field ...> ... </Field>
 *       ...
 *       <SubmitButton pending={pending}>Save customer</SubmitButton>
 *     </FormShell>
 *   );
 */
export function FormShell({
  state,
  action,
  children,
  className,
  noRefreshOnSuccess,
}: {
  state: FormState;
  action: (payload: FormData) => void;
  children: ReactNode;
  className?: string;
  /** Opt out of router.refresh on successful submit (rarely needed). */
  noRefreshOnSuccess?: boolean;
}) {
  const router = useRouter();

  useEffect(() => {
    if (!state.ok) return;
    if (state.redirectTo) {
      router.push(state.redirectTo);
      return;
    }
    if (!noRefreshOnSuccess) {
      router.refresh();
    }
    // We intentionally depend on `submittedAt` so this fires on every
    // successful submission, not just the first transition to ok=true.
  }, [state.ok, state.redirectTo, state.submittedAt, router, noRefreshOnSuccess]);

  return (
    <form
      action={action}
      className={className ?? "space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"}
      noValidate
    >
      <FormErrorBanner error={state.error} />
      <FormSuccessBanner message={state.ok ? state.successMessage : null} />
      {children}
    </form>
  );
}

/**
 * Submit button that surfaces a pending state. Pass the `pending` value
 * from useActionState directly.
 */
export function SubmitButton({
  pending,
  children,
  className,
}: {
  pending: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="submit"
      disabled={pending}
      className={
        className ??
        "inline-flex items-center justify-center gap-2 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
      }
    >
      {pending ? "Saving…" : children}
    </button>
  );
}
