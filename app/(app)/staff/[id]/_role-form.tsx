"use client";

import { useActionState, useEffect } from "react";
import { INITIAL_FORM_STATE, type FormState } from "@/lib/forms/state";

type RoleAction = (
  prevState: FormState<Record<string, unknown>>,
  formData: FormData,
) => Promise<FormState<Record<string, unknown>>>;

/**
 * Role selector. Navigates with `window.location.assign` (NOT the redirect()
 * inside the action): /staff/[id] sits at a route-swap depth where Next 15.5
 * intermittently drops a server-action redirect (D-12). The destination
 * (`?saved=role` or `?error=…`) is decided by the action; this only follows it.
 */
export function StaffRoleForm({
  action,
  roles,
  current,
}: {
  action: RoleAction;
  roles: readonly string[];
  current: string;
}) {
  const [state, formAction, pending] = useActionState(
    action,
    INITIAL_FORM_STATE as FormState<Record<string, unknown>>,
  );

  useEffect(() => {
    if (state.ok && state.redirectTo) window.location.assign(state.redirectTo);
  }, [state.ok, state.redirectTo, state.submittedAt]);

  return (
    <form action={formAction} className="mt-3 flex items-end gap-2">
      <label className="block text-xs text-slate-600">
        Role
        <select
          name="role"
          defaultValue={current}
          className="mt-1 block rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
        >
          {roles
            .filter((r) => r !== "owner")
            .map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          {current === "owner" ? <option value="owner">owner</option> : null}
        </select>
      </label>
      <button
        type="submit"
        disabled={pending || current === "owner"}
        className="rounded-md border border-slate-300 bg-white px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
        title={current === "owner" ? "Owner role can't be changed here" : "Update role"}
      >
        {pending ? "Updating…" : "Update"}
      </button>
    </form>
  );
}
