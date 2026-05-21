/**
 * Shared form-state machinery for React 19 `useActionState`-driven forms.
 *
 * Why this exists: until now every server action either redirected with
 * a querystring error (which wipes form state) or returned a bespoke
 * `{ ok, error, fieldErrors }` shape. This module gives one canonical
 * type + builder so every form across the app gets the same UX:
 *
 *   - Inline field errors next to each input
 *   - Form-level error banner for non-field problems
 *   - Pending state via React's <Form> + useFormStatus
 *   - Success feedback (the action returns a fresh state with ok=true)
 *   - **User input preserved** — the action echoes `values` back so the
 *     form can re-render with what the user typed even after a Zod fail.
 *
 * Server action signature:
 *   async function myAction(
 *     prevState: FormState<...>,
 *     formData: FormData,
 *   ): Promise<FormState<...>>
 *
 * Client usage:
 *   const [state, action, pending] = useActionState(myAction, INITIAL_FORM_STATE);
 *   <form action={action}>...</form>
 *
 * Server/client-safe — no server-only imports.
 */

import type { z, ZodSchema } from "zod";

/** Shape returned by EVERY form-action. Generic over the parsed-input type. */
export type FormState<Values = Record<string, unknown>> = {
  /** True only after a successful submit. New form mounts start with ok=false + no errors. */
  ok: boolean;
  /** Single sentence; rendered at the top of the form. Null when there's no form-level error. */
  error: string | null;
  /** Per-field validation messages, keyed by form-field name. */
  fieldErrors: Record<string, string>;
  /** Echo of the submitted values so the form can repopulate after a validation failure. */
  values: Partial<Values>;
  /** Optional success message — when ok=true, rendered as a banner. */
  successMessage?: string;
  /** Optional redirect target — when ok=true AND non-null, client navigates here. */
  redirectTo?: string;
  /** Stamp updated on every action call; useful for triggering useEffect side-effects per-submission. */
  submittedAt?: number;
};

export const INITIAL_FORM_STATE: FormState = {
  ok: false,
  error: null,
  fieldErrors: {},
  values: {},
};

/** Sentinel value distinguishing "form has never been submitted" from "form was submitted with no errors". */
export function isPristine(state: FormState): boolean {
  return !state.submittedAt;
}

/**
 * Validate `FormData` against a Zod schema. Returns either parsed input
 * OR a `FormState` failure ready to return from the action.
 *
 * Usage in an action:
 *   const result = validateFormData(formData, schema, prevState.values);
 *   if (!result.ok) return result.state;
 *   const data = result.data;
 *   // ... do the work
 */
export function validateFormData<S extends ZodSchema>(
  formData: FormData,
  schema: S,
  previousValues: Partial<z.infer<S>> = {},
):
  | { ok: true; data: z.infer<S>; rawValues: Record<string, string> }
  | { ok: false; state: FormState<z.infer<S>> } {
  const raw: Record<string, string> = {};
  formData.forEach((v, k) => {
    if (typeof v === "string") raw[k] = v;
  });

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && !fieldErrors[key]) {
        fieldErrors[key] = issue.message;
      }
    }
    return {
      ok: false,
      state: {
        ok: false,
        error: "Fix the highlighted fields and try again.",
        fieldErrors,
        // Echo what the user typed (best-effort string coercion). Previous
        // values are merged in so unsubmitted defaults stick.
        values: { ...previousValues, ...(raw as Partial<z.infer<S>>) },
        submittedAt: Date.now(),
      },
    };
  }
  return { ok: true, data: parsed.data, rawValues: raw };
}

/** Convenience: build a generic error state when something off-form goes wrong. */
export function formError<V>(
  message: string,
  echoValues: Partial<V> = {},
): FormState<V> {
  return {
    ok: false,
    error: message,
    fieldErrors: {},
    values: echoValues,
    submittedAt: Date.now(),
  };
}

/** Convenience: build a success state. */
export function formSuccess<V>(
  options: { successMessage?: string; redirectTo?: string; values?: Partial<V> } = {},
): FormState<V> {
  return {
    ok: true,
    error: null,
    fieldErrors: {},
    values: options.values ?? {},
    successMessage: options.successMessage,
    redirectTo: options.redirectTo,
    submittedAt: Date.now(),
  };
}
